import assert from "node:assert/strict";
import { test } from "node:test";
import { INVOICE_ROWS_ABOVE_CARDS, INVOICE_ROWS_ABOVE_FOOTER, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";

/*
 * The invoice in the quotation's style (Sean, 2026-10-07): the quotation's header
 * band, info strip, line-item table, totals box and footer band, WITHOUT the
 * vehicle showcase, and what a tax invoice needs. Row limits measured in headless
 * Chrome on A4 (2026-10-07): 9 single-line items leave a row's space above the
 * payment cards (one wrapped description still fits); 14 reach where the page-1
 * footer band was.
 */

const doc = standardTemplateFor("invoice");
const json = JSON.stringify(doc);
const blocks = doc.pages[0].rows.flatMap((r) => r.columns.flatMap((c) => c.blocks));
const floats = doc.pages[0].floatingBlocks ?? [];

const tokens = {
  "invoice.number": "INV-1042", "invoice.date": "7 Oct 2026", "quote.number": "Q-1042",
  "invoice.billedTo": "082 000 0000\njane@example.com", "quote.subtotal": "R 205 652,17", "quote.vat": "R 30 847,83",
  "quote.vatRate": "15%", "quote.total": "R 236 500,00", "customer.name": "Jane Buyer",
  "company.name": "Denago Cape Town", "company.phone": "021 000 0000", "company.email": "sales@example.com",
  "company.address": "Maitland, Cape Town", "company.tagline": "Premium electric mobility", "company.website": "denago.example",
  preparedBy: "Sam Seller",
};
const render = (n: number) => renderDocumentHtml(doc, {
  tokens,
  items: Array.from({ length: n }, (_, i) => ({ cells: [{ value: `Line ${i + 1}` }, { value: "1" }, { value: "R 1,00" }, { value: "R 1,00" }] })),
  vars: { quote: { taxInclusive: true } },
  bound: true,
} as never);

test("the quotation's look — header band, info strip, showcase table, totals box, footer band — with no vehicle showcase", () => {
  const types: string[] = [...blocks.map((b) => b.type), ...floats.map((f) => f.block.type)];
  for (const type of ["showcaseHeader", "infoStrip", "lineItems", "totalsBox", "footerBand"]) assert.ok(types.includes(type), type);
  assert.ok(!types.includes("vehicleShowcase"), "no showcase model");
  assert.ok(!types.includes("acceptance"), "an invoice isn't signed to accept");
  assert.deepEqual(doc.recipients, []);
  assert.deepEqual(doc.pages[0].overlayFields ?? [], []);
});

test("what a tax invoice says: TAX INVOICE and its number, bill to / from with the VAT number, the quote, totals with VAT, how to pay", () => {
  const html = render(1);
  for (const text of ["TAX INVOICE", "INV-1042", "INVOICE DATE", "QUOTE REFERENCE", "Q-1042", "BILL TO", "Jane Buyer", "FROM", "VAT no:",
    "Subtotal", "VAT", "TOTAL DUE INCL. VAT", "R 236 500,00", "BANKING DETAILS", "PAYMENT TERMS", "Please use INV-1042 as your payment reference"]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /\{\{/, "every token resolves");
  // The two lines to fill in once are visible, not hidden.
  assert.match(json, /\(add your VAT number\)/);
  assert.match(json, /\(add your account number\)/);
});

test("a long invoice moves the payment cards to a second page, as the quotation does", () => {
  assert.equal(INVOICE_ROWS_ABOVE_CARDS, 9);
  assert.equal(INVOICE_ROWS_ABOVE_FOOTER, 13);
  const [cards, footer] = doc.pages[0].overflowGroups ?? [];
  assert.equal(cards.maxItems, INVOICE_ROWS_ABOVE_CARDS);
  assert.equal(cards.floatIds.length, 2, "banking and payment cards move together");
  assert.ok(cards.nextPageFloats?.some((f) => f.block.type === "showcaseHeader" && f.block.compact), "a compact header on page 2");
  assert.equal(footer.maxItems, INVOICE_ROWS_ABOVE_FOOTER);
  assert.equal(footer.drop, true);
  assert.equal((render(9).match(/BANKING DETAILS/g) ?? []).length, 1);
  assert.ok(render(10).includes("BANKING DETAILS"), "still printed, on page 2");
});
