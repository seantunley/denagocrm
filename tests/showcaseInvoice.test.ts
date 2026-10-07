import assert from "node:assert/strict";
import { test } from "node:test";
import { INVOICE_ROWS_ABOVE_CARDS, INVOICE_ROWS_ABOVE_FOOTER, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";

/*
 * The invoice as Sean's mock-up (2026-10-07), in the "classic" look: photo header
 * band (logo, TAX INVOICE, the labelled number), grey info strip, BILL TO / FROM
 * as plain columns, a light-headed table, subtotal / VAT over the dark TOTAL DUE
 * bar (amount in orange), BANKING DETAILS (label/value rows, reference picked out)
 * beside PAYMENT TERMS, a thank-you line and a slim footer. Row limits measured
 * in headless Chrome on A4: 4 lines leave room above the payment section; 9 stay
 * clear of the page-1 footer, beyond which it gives way.
 */

const doc = standardTemplateFor("invoice");
const json = JSON.stringify(doc);
const blocks = doc.pages[0].rows.flatMap((r) => r.columns.flatMap((c) => c.blocks));
const floats = doc.pages[0].floatingBlocks ?? [];
const all = [...blocks, ...floats.map((f) => f.block)];

const tokens = {
  "invoice.number": "INV-1042", "invoice.date": "7 Oct 2026", "quote.number": "Q-1042",
  "invoice.billedTo": "Attention: Johan\nVAT: 4567891230", "quote.subtotal": "R 205 652,17", "quote.vat": "R 30 847,83",
  "quote.vatRate": "15%", "quote.total": "R 236 500,00", "customer.name": "ABC Motors (Pty) Ltd",
  "company.name": "Denago Cape Town", "company.phone": "021 000 0000", "company.email": "sales@example.com",
  "company.address": "Maitland, Cape Town", "company.website": "denago.example", preparedBy: "Sam Seller",
};
const render = (n: number) => renderDocumentHtml(doc, {
  tokens,
  items: Array.from({ length: n }, (_, i) => ({ cells: [{ value: `Line ${i + 1}` }, { value: "1" }, { value: "R 1,00" }, { value: "R 1,00" }] })),
  vars: { quote: { taxInclusive: true } },
  bound: true,
} as never);

test("the mock-up's pieces, in the classic look — and no vehicle showcase, acceptance or signers", () => {
  const byType = (t: string) => all.find((b) => b.type === t) as Record<string, unknown> | undefined;
  for (const t of ["showcaseHeader", "infoStrip", "totalsBox", "footerBand"]) assert.equal(byType(t)?.style, "classic", t);
  assert.equal(byType("lineItems")?.look, "classic");
  assert.ok(all.filter((b) => b.type === "infoCard").every((b) => b.type === "infoCard" && b.look === "classic"));
  const types: string[] = all.map((b) => b.type);
  assert.ok(!types.includes("vehicleShowcase"));
  assert.ok(!types.includes("acceptance"));
  assert.deepEqual(doc.recipients, []);
  assert.deepEqual(doc.pages[0].overlayFields ?? [], []);
});

test("what the invoice says: number, dates, both parties with the VAT number, totals, how to pay", () => {
  const html = render(1);
  for (const text of ["TAX INVOICE", "Invoice number", "INV-1042", "INVOICE DATE", "QUOTE REFERENCE", "Q-1042", "PREPARED BY",
    "BILL TO", "ABC Motors (Pty) Ltd", "FROM", "VAT No", "Subtotal", "TOTAL DUE", "R 236 500,00",
    "BANKING DETAILS", "Account number", "Reference", "PAYMENT TERMS", "Thank you for your business.", "Invoice INV-1042"]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /\{\{/, "every token resolves");
  // Label/value lines line up in two columns; the reference is picked out.
  assert.match(html, /grid-template-columns:104px minmax\(0,1fr\)[^>]*><span[^>]*>Attention<\/span><span[^>]*>Johan<\/span>/);
  assert.match(html, /background:#eef0f3[^"]*"><span[^>]*>Reference<\/span><span[^>]*>INV-1042<\/span>/);
  // The lines to fill in once are visible, not hidden.
  assert.match(json, /\(add your VAT number\)/);
  assert.match(json, /\(add your account number\)/);
});

test("the total is in the accent (orange) on the dark bar — Sean", () => {
  const totals = all.find((b) => b.type === "totalsBox");
  assert.ok(totals && totals.type === "totalsBox");
  assert.equal(totals.accent, "#ea580c");
  assert.match(render(1), /color:#ea580c;font-size:21pt;font-weight:800;white-space:nowrap">R 236 500,00/);
});

test("a long invoice moves the payment section to a second page under a compact header", () => {
  assert.equal(INVOICE_ROWS_ABOVE_CARDS, 4);
  assert.equal(INVOICE_ROWS_ABOVE_FOOTER, 9);
  const [cards, footer] = doc.pages[0].overflowGroups ?? [];
  assert.equal(cards.maxItems, INVOICE_ROWS_ABOVE_CARDS);
  assert.equal(cards.floatIds.length, 4, "rule, banking, payment terms and thank-you move together");
  assert.ok(cards.nextPageFloats?.some((f) => f.block.type === "showcaseHeader" && f.block.compact), "a compact header on page 2");
  assert.equal(footer.maxItems, INVOICE_ROWS_ABOVE_FOOTER);
  assert.equal(footer.drop, true);
  assert.equal((render(4).match(/BANKING DETAILS/g) ?? []).length, 1);
  assert.ok(render(5).includes("BANKING DETAILS"), "still printed, on page 2");
});

test("the quotation is untouched: its bands keep the band look", () => {
  const quote = JSON.stringify(standardTemplateFor("quote"));
  assert.doesNotMatch(quote, /"style":"classic"|"look":"classic"/);
});
