import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { boundRowCount } from "../src/lib/doceditor/overflow";
import { inlineLegacyText } from "../src/lib/doceditor/inlineLegacyText";
import { newBlock } from "../src/lib/doceditor/factory";
import type { DocumentBlock, DocumentModel } from "../src/lib/doceditor/model";
import { rewriteStatementTokens, statementLayoutFromInvoice } from "../src/lib/doceditor/statementLayout";
import { buildAccountStatement, type StatementQuote } from "../src/lib/accountStatement";
import { billedElsewhereNote, statementDocTokens, statementRows, statementWarningsHtml } from "../src/lib/statementDoc";
import type { QuoteBillTo } from "../src/lib/quoteBillTo";

/*
 * Sean, 2026-10-28: "that statement is built in the old format… look at the
 * invoice template… not even picking up the banking". The statement now prints
 * from the document editor, and its layout starts as the workspace's PUBLISHED
 * invoice, converted: same header, colours, banking details, payment terms and
 * footer, with the invoice's own parts swapped for the statement's.
 */

const read = (path: string) => readFileSync(path, "utf8");
const allBlocks = (doc: DocumentModel): DocumentBlock[] => {
  const out: DocumentBlock[] = [];
  const walk = (block: DocumentBlock) => {
    out.push(block);
    if (block.type === "conditional") block.blocks.forEach(walk);
  };
  for (const page of doc.pages) {
    page.rows.forEach((row) => row.columns.forEach((column) => column.blocks.forEach(walk)));
    page.floatingBlocks.forEach((float) => walk(float.block));
    page.overflowGroups?.forEach((group) => group.nextPageFloats?.forEach((float) => walk(float.block)));
  }
  doc.header.forEach(walk);
  doc.footer.forEach(walk);
  return out;
};
const byType = <T extends DocumentBlock["type"]>(doc: DocumentModel, type: T) =>
  allBlocks(doc).filter((block): block is Extract<DocumentBlock, { type: T }> => block.type === type);

// The workspace's invoice as the owner left it: the standard layout with their bank written in.
const invoice = (() => {
  const doc = standardTemplateFor("invoice");
  return JSON.parse(
    JSON.stringify(doc)
      .replace("Bank: (add your bank)", "Bank: First National Bank")
      .replace("Account number: (add your account number)", "Account number: 62812345678"),
  ) as DocumentModel;
})();
const statementDoc = statementLayoutFromInvoice(invoice);

test("the statement keeps the invoice's design — header style, colours, fonts, page geometry", () => {
  assert.deepEqual(statementDoc.style, invoice.style);
  assert.equal(statementDoc.pages.length, invoice.pages.length);
  assert.deepEqual(
    statementDoc.pages[0].floatingBlocks.map((float) => [float.x, float.y, float.width]),
    invoice.pages[0].floatingBlocks.map((float) => [float.x, float.y, float.width]),
  );
  const [header] = byType(statementDoc, "showcaseHeader").filter((block) => !block.compact);
  const [invoiceHeader] = byType(invoice, "showcaseHeader").filter((block) => !block.compact);
  assert.equal(header.style, invoiceHeader.style);
  assert.equal(header.bgImage, invoiceHeader.bgImage);
  assert.equal(header.bg, invoiceHeader.bg);
});

test("the banking details and payment terms are the invoice's own — the reference becomes the statement's", () => {
  const banking = byType(statementDoc, "infoCard").find((card) => card.label === "BANKING DETAILS");
  assert.ok(banking, "the banking card is carried over");
  assert.match(banking.lines, /Bank: First National Bank/);
  assert.match(banking.lines, /Account number: 62812345678/);
  assert.match(banking.lines, /Reference: \{\{statement\.reference\}\}/);
  assert.ok(byType(statementDoc, "infoCard").some((card) => card.label === "PAYMENT TERMS"));
});

test("the invoice's own parts become the statement's", () => {
  const headers = byType(statementDoc, "showcaseHeader");
  assert.ok(headers.length >= 2, "the continuation header too");
  for (const header of headers) {
    assert.equal(header.title, "STATEMENT");
    assert.equal(header.docNumber, "{{statement.date}}");
  }
  assert.equal(headers.find((header) => !header.compact)?.numberLabel, "Statement date");
  const [strip] = byType(statementDoc, "infoStrip");
  assert.deepEqual(strip.items.map((item) => item.value), ["{{statement.date}}", "{{statement.accountName}}", "{{statement.balance}}"]);
  const statementFor = byType(statementDoc, "infoCard").find((card) => card.label === "STATEMENT FOR");
  assert.equal(statementFor?.lines, "{{statement.accountLines}}");
  assert.equal(byType(statementDoc, "lineItems").length, 0);
  const [table] = byType(statementDoc, "statementLines");
  assert.equal(table.look, "classic", "drawn in the invoice table's look");
  assert.deepEqual(table.columns.map((column) => column.key), ["date", "reference", "description", "charges", "payments", "balance"]);
  const [totals] = byType(statementDoc, "totalsBox");
  assert.deepEqual(totals.rows.map((row) => row.value), ["{{statement.invoiced}}", "{{statement.paid}}"]);
  assert.equal(totals.totalAmount, "{{statement.balance}}");
  assert.equal(totals.totalLabel, "{{statement.balanceLabel}}");
  // No invoice, quote or agreement field survives: a statement has no single quote behind it.
  assert.doesNotMatch(JSON.stringify(statementDoc), /\{\{\s*(?:invoice|quote|agreement|lead)\./);
  assert.equal(statementDoc.title, "Statement");
  assert.deepEqual(statementDoc.recipients, []);
});

test("an older invoice whose banking still hangs on {{invoice.bankingDetails}} keeps it, once the text is written in", () => {
  const legacy: DocumentModel = JSON.parse(JSON.stringify(invoice));
  const banking = newBlock("conditional");
  if (banking.type === "conditional") {
    banking.when = "invoice.bankingDetails";
    const card = newBlock("infoCard");
    if (card.type === "infoCard") { card.label = "BANKING"; card.name = ""; card.lines = "{{invoice.bankingDetails}}"; }
    banking.blocks = [card];
  }
  legacy.pages[0].rows[0].columns[0].blocks.push(banking);
  // What statementLayoutFromPublishedInvoice does first (as Publish does): write the old text in.
  const inlined = inlineLegacyText("invoice", legacy, {
    intro: { text: "", on: true },
    paymentTerms: { text: "", on: false },
    bankingDetails: { text: "Bank: Nedbank\nAccount: 1234", on: true },
  }) as DocumentModel;
  const converted = JSON.stringify(statementLayoutFromInvoice(inlined));
  assert.match(converted, /Bank: Nedbank\\nAccount: 1234/);
  // Without that step the conversion would blank the field and lose the section — the reported bug.
  assert.equal(rewriteStatementTokens("{{invoice.bankingDetails}}"), "");
});

const day = (iso: string) => new Date(`${iso}T09:00:00.000Z`);
const quote = (overrides: Partial<StatementQuote> = {}): StatementQuote => ({
  id: "q1", number: 101, status: "accepted", invoiceNumber: 512_340, invoicedAt: day("2026-09-01"), signedAt: null,
  createdAt: day("2026-08-20"), deletedAt: null, supersededAt: null, depositPaidAt: day("2026-09-05"), depositPaidCents: 2_500_000,
  taxInclusive: true, depositType: null, depositValue: null, items: [{ qty: 1, unitPriceCents: 10_000_000, taxRatePct: 15 }], fees: [], ...overrides,
});
const billTo: QuoteBillTo = {
  name: "Lagoon Lodge (Pty) Ltd", attention: "Anna Jacobs", phone: "021 555 0101", email: "accounts@lagoon.example",
  address: "1 Beach Rd, Hermanus", addressLines: ["1 Beach Rd", "Hermanus"], vatNumber: "4123456789", registrationNumber: "", isFleet: true,
};
const company = { "company.name": "Denago Cape Town", "company.website": "denago.example", "company.address": "Maitland", "company.phone": "021", "company.email": "sales@example.com" };
const renderFor = (quotes: StatementQuote[]) => {
  const statement = buildAccountStatement(quotes, []);
  const { tokens, vars } = statementDocTokens(statement, billTo, day("2026-10-28"));
  return renderDocumentHtml(statementDoc, {
    tokens: { ...company, ...tokens },
    items: [],
    statementRows: statementRows(statement),
    vars,
    bound: true,
  });
};
const plain = (html: string) => html.replace(/[  ]/g, " ");

test("printed: the statement's own words and figures, the invoice's banking, nothing left unfilled", () => {
  const html = plain(renderFor([quote()]));
  for (const text of [
    "STATEMENT", "Statement date", "28 Oct 2026", "STATEMENT FOR", "Lagoon Lodge (Pty) Ltd", "Attention", "Anna Jacobs",
    "INV-512340", "Invoice INV-512340 (quote Q-101)", "Deposit received — INV-512340",
    "R 100 000,00", "R 25 000,00", "R 75 000,00", "Total invoiced", "Less deposits &amp; payments", "BALANCE DUE",
    "BANKING DETAILS", "First National Bank", "62812345678", "PAYMENT TERMS", "Statement 28 Oct 2026",
  ]) {
    assert.ok(html.includes(text), text);
  }
  // The one open invoice is the reference to pay against.
  assert.match(html, /<span[^>]*>Reference<\/span><span[^>]*>INV-512340<\/span>/);
  assert.doesNotMatch(html, /TAX INVOICE|Invoice number/);
  assert.doesNotMatch(html, /\{\{/, "every field resolves");
});

test("a long statement moves the banking section to page 2, as a long invoice does", () => {
  const many = Array.from({ length: 6 }, (_, i) => quote({ id: `q${i}`, number: 200 + i, invoiceNumber: 600 + i }));
  assert.equal(boundRowCount({ bound: true, items: [], statementRows: new Array(12).fill({}) }), 12, "the statement's rows count");
  const short = renderFor([quote()]);
  const long = renderFor(many);
  assert.equal((short.match(/class="doc-page/g) ?? []).length, 1);
  assert.ok((long.match(/class="doc-page/g) ?? []).length >= 2, "a continuation page");
  assert.ok(long.includes("BANKING DETAILS"), "still printed, on the next page");
});

test("staff warnings and notes are screen-only (doc-toolbar is hidden in print) and escaped", () => {
  const html = statementWarningsHtml(['Q-102 is cancelled but has <R 500> recorded'], billedElsewhereNote([{ fleetName: "Lagoon & Co", count: 2 }]));
  assert.match(html, /^<div class="doc-toolbar"/);
  assert.match(html, /Check before sending — this box is not printed/);
  assert.match(html, /&lt;R 500&gt;/);
  assert.match(html, /2 invoices billed to Lagoon &amp; Co/);
  assert.equal(statementWarningsHtml([], null), "");
  assert.equal(billedElsewhereNote([]), null);
  const printed = renderDocumentHtml(statementDoc, null, undefined, { toolbarHtml: html });
  assert.match(printed, /@media print \{ \.doc-toolbar \{ display: none !important; \} \}/);
});

test("the statement table is a real editor block: made, previewed with sample rows, and edited", () => {
  const block = newBlock("statementLines");
  assert.equal(block.type, "statementLines");
  const standard = renderDocumentHtml(
    { ...statementDoc, pages: [{ ...statementDoc.pages[0], rows: [{ id: "r", settings: { gap: 16, keepTogether: false, keepWithNext: false }, columns: [{ id: "c", widthPercent: 100, blocks: [block] }] }], floatingBlocks: [], overflowGroups: undefined }] },
    null,
  );
  assert.match(standard, /Statement lines appear here when it is printed for a customer/);
  assert.match(read("src/components/doceditor/BlockView.tsx"), /case "statementLines":\s*return <PrintedBlock block=\{block\} hint="🔗 Fills from the customer's account when the statement prints" \/>;/);
  assert.match(read("src/components/doceditor/Palette.tsx"), /\{ type: "statementLines", label: "Statement lines \(bound\)"/);
  assert.match(read("src/components/doceditor/PropertiesPanel.tsx"), /\{block\.type === "statementLines" && <StatementLinesProps block=\{block\} \/>\}/);
});

test("Statement is a document type: a Sales layout seeded from the published invoice, and printed from it", () => {
  const store = read("src/lib/docbuilder/store.ts");
  assert.match(store, /if \(key === "statement"\) \{\s*const fromInvoice = await statementLayoutFromPublishedInvoice\(\);/);
  // The invoice is read directly (defaultBuilderTemplateId seeds — and seeding calls this) and its old text written in first.
  const helper = store.slice(store.indexOf("export async function statementLayoutFromPublishedInvoice"));
  assert.doesNotMatch(helper.slice(0, helper.indexOf("\n}\n")), /defaultBuilderTemplateId|publishedBuilderTemplateFor|ensureBuilderSeeded/);
  assert.match(helper, /if \(!invoice \|\| invoice\.publishedVersion == null\) return null;/);
  assert.match(helper, /await withLegacyTextInlined\(\{ key: "invoice", data: live\.data \}\)/);

  const print = read("src/lib/statementDocPrint.ts");
  assert.match(print, /const own = await publishedBuilderTemplateFor\("statement"\);/);
  assert.match(print, /return statementLayoutFromPublishedInvoice\(\);/);
});

test("statement routes: the page's gates, the workspace bound, and the old page kept as the fallback", () => {
  for (const [kind, gate] of [
    ["contacts", /const user = await requireContactReadAccess\(id\);\s*await requireAnyPermission\("quotes\.view_all", "quotes\.view_owned"\);/],
    ["fleets", /await requireModuleEnabled\("automotive"\);\s*const user = await requireRoute\("\/fleets"\);\s*await requireAnyPermission\("quotes\.view_all", "quotes\.view_owned"\);/],
  ] as const) {
    const route = read(`src/app/(print)/${kind}/[id]/statement/document/route.ts`);
    assert.match(route, /return withActingStaffScope\(async \(\) => \{/);
    assert.match(route, gate);
    assert.ok(route.search(gate) < route.indexOf("renderStatementDocHtml("), "no data before the gate");
    assert.match(route, new RegExp(`if \\(result\\.kind !== "ok"\\) redirect\\(\`/${kind}/\\$\\{id\\}/statement\\?legacy=1\`\\);`));
    assert.match(route, /"Cache-Control": "private, no-store"/);
    const page = read(`src/app/(print)/${kind}/[id]/statement/page.tsx`);
    assert.match(page, new RegExp(`if \\(!\\(await searchParams\\)\\.legacy && \\(await statementPrintLayout\\(\\)\\)\\) redirect\\(\`/${kind}/\\$\\{id\\}/statement/document\`\\);`));
    assert.ok(page.indexOf("requireAnyPermission(") < page.indexOf("statementPrintLayout()"), "gates first");
  }
});
