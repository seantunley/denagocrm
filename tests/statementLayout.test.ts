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
  // A Statement is one of the workspace's own layout types (review of #925), so
  // the shared rules apply to it: the door every by-id read and action uses, the
  // list, set-default, new layouts and seeding once per workspace, stamped as its
  // own (tests/invoiceTemplateWorkspace.test.ts pins those rules themselves).
  assert.match(read("src/lib/docbuilder/layoutScope.ts"), /export const WORKSPACE_LAYOUT_KEYS: ReadonlySet<string> = new Set\(\["invoice", "agreement", "statement"\]\);/);
  // …and its first layout is the workspace's own invoice, converted.
  assert.match(store, /data: \(await seedLayout\(key, workspaceScope\)\) as object,/);
  assert.match(store, /if \(key === "statement" && workspaceScope\) \{\s*const fromInvoice = await statementLayoutFromPublishedInvoice\(workspaceScope\);\s*if \(fromInvoice\) return fromInvoice;\s*\}/);
  // A Statement made before the invoice was published is rebuilt from it by name.
  assert.match(read("src/app/doc-editor/[id]/page.tsx"), /standardLabel=\{template\.key === "statement" \? "published invoice" : undefined\}/);
  // The invoice is read directly (defaultBuilderTemplateId seeds — and seeding calls this), from the workspace's
  // own (review of #925), and its old text written in first — from the same workspace's old form editor.
  const helper = store.slice(store.indexOf("export async function statementLayoutFromPublishedInvoice"));
  assert.doesNotMatch(helper.slice(0, helper.indexOf("\n}\n")), /defaultBuilderTemplateId|publishedBuilderTemplateFor|ensureBuilderSeeded/);
  assert.match(helper, /where: \{ key: "invoice", deletedAt: null, \.\.\.layoutScopeWhere\(scope\) \}/);
  assert.match(helper, /if \(!invoice \|\| invoice\.publishedVersion == null\) return null;/);
  assert.match(helper, /await withLegacyTextInlined\(\{ key: "invoice", data: live\.data \}, scope\)/);
  assert.match(store, /const old = await getDocTemplateText\(template\.key, scope\);/);
  assert.match(read("src/lib/docTemplateStore.ts"), /where: \{ docType: key, isDefault: true, deletedAt: null, \.\.\.\(scope \? layoutScopeWhere\(scope\) : \{\}\) \}/);

  const print = read("src/lib/statementDocPrint.ts");
  assert.match(print, /const scope = await actingLayoutScope\(\);\s*const own = await publishedBuilderTemplateFor\("statement", scope\);/);
  assert.match(print, /return statementLayoutFromPublishedInvoice\(scope\);/);
  // Reset to standard writes the workspace's banking only into a statement of its own.
  assert.match(
    read("src/app/actions/docbuilder.ts"),
    /const fromInvoice = scope && layoutRowVisible\(tpl\.tenantId, scope\) \? await statementLayoutFromPublishedInvoice\(scope\) : null;/,
  );
});

// Review of #925: an invoice layout with an acceptance card carried it into the
// statement, which then printed blank name, signature and date lines.
const signingBlock = (type: "acceptance" | "handoverChecklist") => newBlock(type);
const keptText = () => {
  const block = newBlock("callout");
  if (block.type === "callout") block.title = "Kept note";
  return block;
};
const wrapped = (blocks: DocumentBlock[], when = "statement.balance") => {
  const block = newBlock("conditional");
  if (block.type === "conditional") {
    block.when = when;
    block.blocks = blocks;
  }
  return block;
};
const rowOf = (id: string, ...columns: DocumentBlock[][]) => ({
  id,
  settings: { gap: 16, keepTogether: false, keepWithNext: false },
  columns: columns.map((blocks, i) => ({ id: `${id}-c${i}`, widthPercent: 100 / columns.length, blocks })),
});
const floatOf = (id: string, block: DocumentBlock, y = 600) => ({ id, x: 48, y, width: 280, block });

const signedInvoice = (() => {
  const doc: DocumentModel = JSON.parse(JSON.stringify(invoice));
  const page = doc.pages[0];
  page.rows.push(
    rowOf("only-acceptance", [signingBlock("acceptance")]),
    rowOf("mixed", [keptText(), wrapped([signingBlock("acceptance"), keptText()])], [signingBlock("handoverChecklist")]),
    rowOf("only-wrapped-acceptance", [wrapped([signingBlock("acceptance")])]),
    rowOf("owners-empty-row", []),
    rowOf("owners-empty-conditional", [wrapped([])]),
  );
  page.floatingBlocks.push(
    floatOf("float-acceptance", signingBlock("acceptance")),
    floatOf("float-wrapped-acceptance", wrapped([signingBlock("acceptance")])),
    floatOf("float-kept", keptText(), 700),
  );
  page.overlayFields.push({
    id: "sig", kind: "signature", anchor: { mode: "page", blockId: null, x: 60, y: 640 }, width: 200, height: 40, recipientId: null, required: true, label: "", options: [],
  });
  page.overflowGroups = [
    ...(page.overflowGroups ?? []),
    // Only something to sign: nothing would be left to move.
    { maxItems: 3, floatIds: ["float-acceptance", "float-wrapped-acceptance"], fieldIds: ["sig"], nextPageFloats: [floatOf("next-acceptance", signingBlock("acceptance"), 100)] },
    // Signing and kept content together: the kept content still moves.
    { maxItems: 3, floatIds: ["float-acceptance", "float-kept"], fieldIds: ["sig"], nextPageFloats: [floatOf("next-acceptance-2", signingBlock("acceptance"), 100), floatOf("next-kept", keptText(), 140)] },
    // Signing fields alone: nothing to move once the fields are gone.
    { maxItems: 3, floatIds: [], fieldIds: ["sig"] },
  ];
  doc.header.push(signingBlock("acceptance"));
  doc.footer.push(wrapped([signingBlock("handoverChecklist")]));
  return doc;
})();
const signedStatement = statementLayoutFromInvoice(signedInvoice);

test("nothing to sign survives: acceptance cards and handover signatures dropped, nested, placed or in the furniture", () => {
  assert.ok(byType(signedInvoice, "acceptance").length >= 6 && byType(signedInvoice, "handoverChecklist").length === 2, "the invoice really had them");
  assert.deepEqual(byType(signedStatement, "acceptance"), []);
  assert.deepEqual(byType(signedStatement, "handoverChecklist"), []);
  const page = signedStatement.pages[0];
  assert.deepEqual(page.overlayFields, []);
  assert.deepEqual(signedStatement.recipients, []);

  // What existed only to hold one goes with it; what the owner left empty, and everything else, stays.
  const rowIds = page.rows.map((row) => row.id);
  assert.ok(!rowIds.includes("only-acceptance") && !rowIds.includes("only-wrapped-acceptance"), rowIds.join(", "));
  assert.ok(rowIds.includes("owners-empty-row") && rowIds.includes("owners-empty-conditional"));
  assert.equal(page.rows.length, invoice.pages[0].rows.length + 3);
  const mixed = page.rows.find((row) => row.id === "mixed");
  assert.deepEqual(mixed?.columns.map((column) => column.blocks.map((block) => block.type)), [["callout", "conditional"], []]);
  const kept = mixed?.columns[0].blocks[1];
  assert.ok(kept?.type === "conditional" && kept.blocks.length === 1 && kept.blocks[0].type === "callout", "the conditional keeps its other content");
  assert.ok(byType(signedStatement, "conditional").some((block) => block.blocks.length === 0), "the owner's own empty conditional is left as it was");

  // Placed blocks and the overflow groups that move them.
  const floats = page.floatingBlocks.map((float) => float.id);
  assert.ok(!floats.includes("float-acceptance") && !floats.includes("float-wrapped-acceptance") && floats.includes("float-kept"));
  const groups = page.overflowGroups ?? [];
  const added = groups.slice(groups.length - 1);
  assert.equal(groups.length, (invoice.pages[0].overflowGroups ?? []).length + 1, "the two groups left with nothing to move are gone");
  assert.deepEqual(added.map((group) => [group.floatIds, group.fieldIds]), [[["float-kept"], []]]);
  assert.deepEqual(added[0].nextPageFloats?.map((float) => float.id), ["next-kept"]);
  for (const group of groups) {
    assert.deepEqual(group.fieldIds, []);
    assert.ok(group.floatIds.every((id) => floats.includes(id) || !signedInvoice.pages[0].floatingBlocks.some((float) => float.id === id)), "no group names a float the conversion removed");
  }
});

test("printed: the converted statement has no signature, name or date lines to fill in", () => {
  const statement = buildAccountStatement([quote()], []);
  const { tokens, vars } = statementDocTokens(statement, billTo, day("2026-10-28"));
  const ctx = { tokens: { ...company, ...tokens }, items: [], statementRows: statementRows(statement), vars, bound: true };
  const before = plain(renderDocumentHtml(signedInvoice, ctx));
  assert.match(before, /ACCEPTANCE OF QUOTATION/, "the invoice printed the card");
  const html = plain(renderDocumentHtml(signedStatement, ctx));
  assert.doesNotMatch(html, /ACCEPTANCE OF QUOTATION|Customer Name|>Signature|Customer signature/);
  assert.ok(html.includes("Kept note") && html.includes("BANKING DETAILS"), "the rest is printed as it was");
  // A long statement moves the kept content, and adds no page carrying only a header and footer.
  const many = Array.from({ length: 6 }, (_, i) => quote({ id: `q${i}`, number: 200 + i, invoiceNumber: 600 + i }));
  const longStatement = buildAccountStatement(many, []);
  const long = plain(renderDocumentHtml(signedStatement, { ...ctx, statementRows: statementRows(longStatement) }));
  assert.doesNotMatch(long, /ACCEPTANCE OF QUOTATION|Customer Name|>Signature/);
  assert.ok(long.includes("Kept note"));
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
