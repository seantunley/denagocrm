import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { hasLegacyTokens, inlineLegacyText } from "../src/lib/doceditor/inlineLegacyText";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";

/*
 * One place for every document (2026-10-07, asked for again and again): the
 * invoice's bank details and payment terms and the agreement's clauses are
 * written INTO their layouts and edited in the document editor, and Document
 * Studio opens that editor for every document — the old form editor is gone.
 */

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const card = (lines: string) => ({ id: "c", type: "infoCard", label: "X", name: "", lines });
const when = (field: string, inner: object) => ({ id: `w-${field}`, type: "conditional", when: field, blocks: [inner] });
// An invoice layout as #673 seeded it: each text behind its old-editor token.
const oldInvoice = {
  pages: [{ rows: [{ columns: [{ blocks: [
    when("invoice.intro", card("{{invoice.intro}}")),
    when("invoice.paymentTerms", card("{{invoice.paymentTerms}}")),
    when("invoice.bankingDetails", card("{{invoice.bankingDetails}}")),
    card("Invoice {{invoice.number}}"),
  ] }] }] }],
};
const blocks = (doc: unknown) => (doc as typeof oldInvoice).pages[0].rows[0].columns[0].blocks as Array<{ type: string; lines?: string }>;

test("the old editor's text is written into the layout, where it is edited from now on", () => {
  assert.equal(hasLegacyTokens("invoice", oldInvoice), true);
  const out = inlineLegacyText("invoice", oldInvoice, {
    intro: { text: "Thank you for your business.", on: true },
    paymentTerms: { text: "Due within 7 days.", on: true },
    bankingDetails: { text: "Bank: FNB\nAccount: 123", on: true },
  });
  assert.deepEqual(blocks(out).map((b) => [b.type, b.lines]), [
    ["infoCard", "Thank you for your business."],
    ["infoCard", "Due within 7 days."],
    ["infoCard", "Bank: FNB\nAccount: 123"],
    ["infoCard", "Invoice {{invoice.number}}"], // a real merge field stays one
  ]);
  assert.equal(hasLegacyTokens("invoice", out), false, "nothing reads the old editor any more");
});

test("a section switched off or left empty stays out, exactly as it printed before", () => {
  const out = inlineLegacyText("invoice", oldInvoice, {
    intro: { text: "", on: true },
    paymentTerms: { text: "", on: true },
    bankingDetails: { text: "Bank: FNB", on: false },
  });
  assert.deepEqual(blocks(out).map((b) => b.lines), ["Invoice {{invoice.number}}"]);
});

test("the agreement's clauses keep their {{company.name}} merge field", () => {
  const agreement = { pages: [{ rows: [{ columns: [{ blocks: [when("agreement.clauses", card("{{agreement.clauses}}"))] }] }] }] };
  const out = inlineLegacyText("agreement", agreement, { intro: { text: "", on: true }, clauses: { text: "4. Delivery at {{company.name}}.", on: true } });
  assert.equal(blocks(out)[0].lines, "4. Delivery at {{company.name}}.");
});

test("new standard layouts start with their text written in", () => {
  const invoice = JSON.stringify(standardTemplateFor("invoice"));
  assert.equal(hasLegacyTokens("invoice", standardTemplateFor("invoice")), false);
  assert.match(invoice, /Bank: \(add your bank\)/);
  assert.match(invoice, /Thank you for your business\./);
  assert.doesNotMatch(invoice, /PAYMENT TERMS/, "no terms written yet → no box, as before");
  assert.equal(hasLegacyTokens("agreement", standardTemplateFor("agreement", { automotive: true })), false);
  assert.match(JSON.stringify(standardTemplateFor("agreement", { automotive: true })), /buy the vehicle\(s\)/);
});

test("Document Studio opens the one editor for every document, and the old form editor only redirects", () => {
  const studio = code("src/app/(app)/document-studio/page.tsx");
  assert.doesNotMatch(studio, /\/settings\/documents\/t\//, "no way into the old form editor");
  assert.match(studio, /<Link href=\{`\/doc-editor\/\$\{layout\.id\}`\}>/);
  assert.match(studio, /\{live \? "Live" : "Not published yet"\}/, "whether each document prints its new layout yet is shown");
  // The quote prints its layout even unpublished, so it is never "not live".
  assert.match(studio, /const live = layout\?\.publishedVersion != null \|\| \(key === "quote" && Boolean\(layout\)\);/);
  const old = code("src/app/(app)/settings/documents/t/[id]/page.tsx");
  assert.match(old, /redirect\(layoutId \? `\/doc-editor\/\$\{layoutId\}` : "\/document-studio"\)/);
  assert.doesNotMatch(old, /updateDocTemplate|<form|SaveForm/);
  // The editor opens an old invoice/agreement with its text written in (no
  // write on GET); Publish stores it, in the draft and the published version.
  assert.match(code("src/app/doc-editor/[id]/page.tsx"), /getBuilderTemplate\(id\)\.then\(\(t\) => \(t \? withLegacyTextInlined\(t\) : null\)\)/);
  const publish = code("src/app/actions/docbuilder.ts");
  assert.match(publish, /const tpl = await withLegacyTextInlined\(found\);/);
  assert.match(publish, /data: \{ templateId: id, version, data: tpl\.data as object/);
  assert.match(publish, /\.\.\.\(tpl\.data !== found\.data \? \{ data: tpl\.data as object \} : \{\}\)/);
  assert.doesNotMatch(code("src/lib/docbuilder/store.ts").slice(code("src/lib/docbuilder/store.ts").indexOf("export async function withLegacyTextInlined")).split("\n}\n")[0], /\.update\(|\.create\(/, "opening writes nothing");
});
