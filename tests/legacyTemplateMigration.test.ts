import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isLegacyBuilderData,
  legacyToDocument,
  readTemplateDocument,
} from "../src/lib/doceditor/legacy";
import { parseDocument } from "../src/lib/doceditor/model";
import { blankDocument, standardQuoteTemplate } from "../src/lib/doceditor/factory";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The template that would not open.
 *
 * This is the VERBATIM `data` column of DocBuilderTemplate
 * cmrn6zgoz0000ji09z3dl8hhu — the "Quotation" row in production, created
 * 2026-07-16, still in the retired Puck format. Its symptom was silent: the
 * builder listed it, /doc-editor opened it BLANK (and autosaves), and its PDF
 * route answered 404 "empty document".
 *
 * Kept byte-for-byte rather than reduced to a fixture, because the point of
 * these tests is that this exact row survives the conversion intact.
 */
const PRODUCTION_ROW = {
  root: { props: {} },
  zones: {},
  content: [
    { type: "Banner", props: { bg: "#020617", id: "b1", title: "QUOTATION", accent: "#ea580c", showLogo: true, subtitle: "Authorized Denago EV Dealer", docNumber: "{{quote.number}}", logoWidth: 72, titleFont: "default", titleSize: 16, titleAlign: "left" } },
    { type: "Spacer", props: { id: "s1", height: 10 } },
    { type: "TwoColumn", props: { id: "tc1", leftName: "{{customer.name}}", leftLabel: "PREPARED FOR", leftLines: "{{customer.phone}} · {{customer.email}}\n{{customer.address}}", rightName: "{{vehicle}}", accentLeft: true, rightLabel: "VEHICLE OF INTEREST", rightLines: "Prepared by {{preparedBy}} · Valid until {{quote.validUntil}}" } },
    { type: "Spacer", props: { id: "s2", height: 8 } },
    { type: "RichText", props: { id: "rt1", value: [{ type: "p", children: [{ text: "Thank you for choosing to go electric. Please find your quotation below — reach out any time with questions." }] }] } },
    { type: "Spacer", props: { id: "s2b", height: 6 } },
    { type: "LineItems", props: { id: "li1", headerBg: "#020617", headerColor: "#ffffff" } },
    { type: "TotalBand", props: { id: "tb1", color: "#ea580c", label: "TOTAL INCL. VAT", amount: "{{quote.total}}" } },
    { type: "Spacer", props: { id: "s3", height: 12 } },
    { type: "Terms", props: { id: "tm1", items: [{ text: "Quote valid for 14 days." }, { text: "50% deposit to secure build slot; balance on delivery." }, { text: "12-month limited warranty; battery 24 months." }, { text: "Prices include 15% VAT." }], title: "TERMS" } },
    { type: "Spacer", props: { id: "s4", height: 20 } },
    { type: "Signature", props: { id: "sig1", leftLabel: "Accepted — customer signature & date", showRight: true, rightLabel: "For Denago Cape Town & date" } },
    { type: "Spacer", props: { id: "s5", height: 16 } },
    { type: "Footer", props: { id: "f1", lines: [{ text: "Denago Cape Town — Authorized Denago EV Dealer" }, { text: "Unit 55, M5 Freeway Business Park, Maitland · sales@denagocpt.co.za · denagocpt.co.za" }], accent: "#ea580c" } },
  ],
};

/** Every block in the document, including those nested in a conditional. */
function allBlocks(doc: NonNullable<ReturnType<typeof legacyToDocument>>) {
  const out: { id: string; type: string }[] = [];
  const walk = (blocks: { id: string; type: string; blocks?: unknown }[]) => {
    for (const block of blocks) {
      out.push(block);
      if (block.type === "conditional") walk((block.blocks ?? []) as typeof blocks);
    }
  };
  for (const page of doc.pages) for (const row of page.rows) for (const column of row.columns) walk(column.blocks);
  return out;
}

test("the production Quotation row no longer parses as empty", () => {
  assert.equal(parseDocument(PRODUCTION_ROW), null, "precondition: the strict parser still rejects it");
  assert.ok(isLegacyBuilderData(PRODUCTION_ROW));
  assert.equal(readTemplateDocument(PRODUCTION_ROW, "Quotation").status, "ok");
});

test("every piece of the production row's content survives conversion", () => {
  const doc = legacyToDocument(PRODUCTION_ROW, "Quotation");
  assert.ok(doc);
  const json = JSON.stringify(doc);

  // Content a user typed or a merge field they placed. Losing any of these
  // silently is the failure mode this converter exists to prevent, so each is
  // asserted by its literal text rather than by block count.
  for (const content of [
    "QUOTATION",
    "{{quote.number}}",
    "Authorized Denago EV Dealer",          // banner subtitle — no model field, carried as text
    "PREPARED FOR", "{{customer.name}}", "{{customer.phone}} · {{customer.email}}",
    "VEHICLE OF INTEREST", "{{vehicle}}", "Valid until {{quote.validUntil}}",
    "Thank you for choosing to go electric",
    "TOTAL INCL. VAT", "{{quote.total}}",
    "Quote valid for 14 days.",
    "50% deposit to secure build slot; balance on delivery.",
    "12-month limited warranty; battery 24 months.",
    "Prices include 15% VAT.",
    "Accepted — customer signature & date",  // Signature has no model block
    "For Denago Cape Town & date",
    "Unit 55, M5 Freeway Business Park, Maitland · sales@denagocpt.co.za · denagocpt.co.za",
  ]) {
    assert.ok(json.includes(content), `lost in conversion: ${content}`);
  }

  const types = allBlocks(doc).map((b) => b.type);
  assert.ok(types.includes("banner"));
  assert.ok(types.includes("lineItems"), "the priced table must still be a lineItems block, not text");
  assert.ok(types.includes("totalBand"));
  assert.ok(types.includes("terms"));
  assert.ok(types.includes("footer"));
  assert.equal(types.filter((t) => t === "infoCard").length, 2, "TwoColumn is two info cards");

  // The two cards sit SIDE BY SIDE, as they did in the legacy render — a
  // converter that stacked them would keep the text and lose the layout.
  const twoUp = doc.pages[0].rows.find((r) => r.columns.length === 2 && r.columns.every((c) => c.blocks[0]?.type === "infoCard"));
  assert.ok(twoUp, "TwoColumn must convert to one row of two columns");
  assert.deepEqual(twoUp.columns.map((c) => c.widthPercent), [50, 50]);
});

test("conversion is deterministic", () => {
  // sendDocForSigning hashes the parsed document into the fingerprint that
  // decides whether an OPEN signature request can be reused. Random ids here
  // would mint a new request — and a new PDF, and a new email to the customer —
  // on every send of a legacy template.
  const a = legacyToDocument(PRODUCTION_ROW, "Quotation");
  const b = legacyToDocument(PRODUCTION_ROW, "Quotation");
  assert.equal(JSON.stringify(a), JSON.stringify(b));

  const ids = allBlocks(a!).map((block) => block.id);
  assert.equal(new Set(ids).size, ids.length, "block ids must be unique");
  assert.ok(ids.every((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)), "ids must be derived, not uuids");
});

test("an unrecognised block refuses the whole conversion", () => {
  // Skipping the unknown block would open the template short of content, and
  // the editor's autosave would then make that loss permanent. Refusing leaves
  // the stored row untouched.
  const withAlien = { ...PRODUCTION_ROW, content: [...PRODUCTION_ROW.content, { type: "Carousel", props: { id: "x1" } }] };
  assert.equal(legacyToDocument(withAlien), null);

  const nestedAlien = {
    root: { props: {} }, zones: {},
    content: [{ type: "Conditional", props: { id: "c1", when: "true", content: [{ type: "Carousel", props: { id: "x1" } }] } }],
  };
  assert.equal(legacyToDocument(nestedAlien), null, "an unknown type nested in a slot must refuse too");
});

test("a non-empty zones map refuses rather than dropping it", () => {
  const withZones = { ...PRODUCTION_ROW, zones: { "tc1:left": [{ type: "Paragraph", props: { id: "p1", text: "hi" } }] } };
  assert.equal(legacyToDocument(withZones), null);
});

test("every legacy block type is handled", () => {
  // Driven off the retired format's own type list so this cannot drift: if
  // BlockProps names a type the converter has no case for, that type would
  // refuse the whole document at read time.
  const source = read("src/lib/docbuilder/blocks.ts");
  const body = source.slice(source.indexOf("export type BlockProps"));
  const declared = [...body.slice(0, body.indexOf("};")).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 17, `expected the full legacy block list, found ${declared.length}`);

  const sample: Record<string, Record<string, unknown>> = {
    TwoColumn: { leftLabel: "L", rightLabel: "R" },
    Table: { columns: [{ header: "H", align: "left", width: 100 }], rows: [{ cells: [{ value: "v" }] }] },
    Terms: { items: [{ text: "t" }] },
    Footer: { lines: [{ text: "f" }] },
    RichText: { value: [{ type: "p", children: [{ text: "x" }] }] },
    Columns: { ratio: "60", gap: 8, left: [], right: [] },
    Conditional: { when: "true", content: [] },
    Image: { src: "https://example.com/a.png", width: 50, align: "left", caption: "", rounded: false },
  };

  for (const type of declared) {
    const doc = legacyToDocument({
      root: { props: {} }, zones: {},
      content: [{ type, props: { id: "only", ...(sample[type] ?? {}) } }],
    });
    assert.ok(doc, `legacy block "${type}" is declared but the converter refuses it`);
  }
});

test("a current-format document is passed through untouched", () => {
  // readTemplateDocument must not reshape documents that already parse — the
  // converter is a fallback, not a normaliser.
  for (const doc of [standardQuoteTemplate(), blankDocument("x")]) {
    const read = readTemplateDocument(doc);
    assert.equal(read.status, "ok");
    assert.deepEqual(read.status === "ok" && read.doc, parseDocument(doc));
  }
  assert.equal(isLegacyBuilderData(standardQuoteTemplate()), false);
  for (const notATemplate of [null, undefined, 42, "x", {}, { content: "nope" }]) {
    assert.equal(legacyToDocument(notATemplate), null);
  }
});

test("unsupported legacy data is distinguishable from an empty row", () => {
  // The whole point of refusing to convert is that callers then STOP. A single
  // `DocumentModel | null` made "we declined to convert this" and "there is
  // nothing here" the same answer, and every caller reads the second one as
  // permission to substitute something else.
  const unsupported = { ...PRODUCTION_ROW, content: [...PRODUCTION_ROW.content, { type: "Carousel", props: { id: "x1" } }] };
  assert.equal(readTemplateDocument(unsupported).status, "unsupported");

  for (const notATemplate of [null, undefined, {}, { schemaVersion: 9 }, { pages: "no" }]) {
    assert.equal(readTemplateDocument(notATemplate).status, "unreadable");
  }
});

test("an unreadable row is not treated as an empty one", () => {
  // `saveBuilderData` wrote `data: unknown` to this column with NO validation
  // before it was removed, so an unreadable row can hold anything somebody
  // saved. And a current-format document with one bad field lands here too —
  // that is a nearly-complete template, not junk.
  const almostValid = { ...standardQuoteTemplate(), recipients: "not-an-array" };
  assert.equal(readTemplateDocument(almostValid).status, "unreadable");
  assert.ok(
    JSON.stringify(almostValid).includes("Quote valid for 14 days."),
    "…and its pages still hold every term, which is what a blank canvas would have replaced",
  );

  // Only `ok` may be acted on. Neither failure may reach a fallback.
  const editor = read("src/app/doc-editor/[id]/page.tsx");
  assert.match(editor, /if \(read\.status !== "ok"\)/, "the editor must refuse on ANY non-ok status");
  assert.doesNotMatch(editor, /blankDocument/, "the editor must have no blank fallback left at all");

  const envelope = read("src/lib/signing/autoEnvelope.ts");
  assert.match(envelope, /if \(read\.status !== "ok"\) return null;/);
  assert.match(envelope, /if \(!template\) return null;/, "a chosen template that is gone must stop too");

  const send = read("src/app/actions/doceditor.ts");
  assert.match(send, /if \(read\.status !== "ok"\)/, "sendDocForSigning must refuse on ANY non-ok status");
});

test("malformed stored JSON fails safely instead of throwing", () => {
  // A stored table can hold a null column or row. Reading `col.header` off it
  // threw, which on the editor route is a 500 rather than a refusal a caller
  // can handle.
  const malformed: unknown[] = [
    { root: {}, zones: {}, content: [{ type: "Table", props: { id: "t", columns: [null], rows: [] } }] },
    { root: {}, zones: {}, content: [{ type: "Table", props: { id: "t", columns: [], rows: [null] } }] },
    { root: {}, zones: {}, content: [{ type: "Table", props: { id: "t", columns: ["x", 3], rows: [{ cells: [null, 7] }] } }] },
    { root: {}, zones: {}, content: [{ type: "Terms", props: { id: "t", items: [null, 5] } }] },
    { root: {}, zones: {}, content: [{ type: "Footer", props: { id: "f", lines: [null] } }] },
    { root: {}, zones: {}, content: [{ type: "Banner", props: null }] },
    { root: {}, zones: {}, content: [{ type: "Spacer", props: "nope" }] },
    { root: {}, zones: {}, content: [null] },
    { root: {}, zones: {}, content: [{ type: "Conditional", props: { id: "c", content: [null] } }] },
    { content: [{ type: "RichText", props: { id: "r", value: [null, "x"] } }] },
  ];
  // "Safely" means it returns a status a caller can act on. A null column
  // degrading to a defaulted one is fine and deliberate — the rest of the table
  // survives, which is the whole policy of this module. Throwing is not.
  for (const input of malformed) {
    let status: string | undefined;
    assert.doesNotThrow(() => { status = readTemplateDocument(input).status; }, `threw on ${JSON.stringify(input)}`);
    assert.ok(["ok", "unsupported", "unreadable"].includes(status!));
  }

  // Prove the guard is load-bearing rather than the null being skipped: the
  // null column arrives as a real, defaulted column. Reading `.header` off it
  // is what used to throw.
  const withNullColumn = legacyToDocument({
    root: {}, zones: {},
    content: [{ type: "Table", props: { id: "t", columns: [null, { header: "Qty", width: 20 }], rows: [] } }],
  });
  assert.ok(withNullColumn);
  const table = withNullColumn.pages[0].rows[0].columns[0].blocks[0];
  assert.equal(table.type, "table");
  assert.deepEqual(
    table.type === "table" && table.columns.map((c) => c.header),
    ["", "Qty"],
    "the null column must survive as an empty one, not vanish",
  );

  // The backstop exists as well as the guards, for the case nobody thought of.
  assert.match(read("src/lib/doceditor/legacy.ts"), /\} catch \{\s*return \{ status: "unsupported" \};/);
});

test("nested side-by-side layout refuses rather than flattening", () => {
  // TwoColumn / Columns / Signature are columns. The current model has no
  // nested row, so inside another block's slot they could only be stacked —
  // a conversion that "succeeds" with the layout altered, which autosave then
  // stores permanently. Each must refuse instead.
  for (const nested of ["TwoColumn", "Columns", "Signature"]) {
    const doc = legacyToDocument({
      root: { props: {} }, zones: {},
      content: [{
        type: "Conditional",
        props: { id: "c1", when: "true", content: [{ type: nested, props: { id: "n1", ratio: "50", left: [], right: [] } }] },
      }],
    });
    assert.equal(doc, null, `${nested} nested in a conditional must refuse, not flatten`);
  }

  // Inside a Columns slot too, not just a conditional.
  assert.equal(legacyToDocument({
    root: { props: {} }, zones: {},
    content: [{ type: "Columns", props: { id: "c1", ratio: "50", left: [{ type: "TwoColumn", props: { id: "t1" } }], right: [] } }],
  }), null);

  // …but at the TOP level, where they become a real row, they still convert.
  for (const top of ["TwoColumn", "Signature"]) {
    const doc = legacyToDocument({ root: { props: {} }, zones: {}, content: [{ type: top, props: { id: "t1" } }] });
    assert.ok(doc, `${top} must still convert at the top level`);
    assert.ok(doc.pages[0].rows[0].columns.length >= 2, `${top} must convert to side-by-side columns`);
  }
});

test("no caller falls back to a substitute on unsupported legacy data", () => {
  // Refusing to convert buys nothing if the next line opens the template blank
  // (the editor autosaves) or swaps in a different document (autoEnvelope sends
  // it for signature).
  const editor = read("src/app/doc-editor/[id]/page.tsx");
  assert.ok(
    editor.indexOf('read.status !== "ok"') < editor.indexOf("<DocEditor"),
    "the refusal must come before the editor is mounted",
  );

  const envelope = read("src/lib/signing/autoEnvelope.ts");
  assert.ok(
    envelope.indexOf('read.status !== "ok"') < envelope.indexOf("standardQuoteTemplate()"),
    "autoEnvelope must return before it can substitute the standard template",
  );
});

test("signed snapshots are still parsed strictly", () => {
  // snapshotJson is the document a person actually signed. Re-deriving it
  // through a converter would mean the rendered artefact is no longer the one
  // that was signed, so those call sites must keep using parseDocument.
  for (const file of ["src/lib/signing/render.ts", "src/lib/signing/complete.ts"]) {
    const code = read(file);
    assert.match(code, /parseDocument\(\s*req\.snapshotJson\s*\)/, `${file} must parse the snapshot strictly`);
    assert.doesNotMatch(code, /parseTemplateDocument/, `${file} must not convert a signed snapshot`);
  }
});

test("nothing writes the legacy format any more", () => {
  // The row this all started with was minted by createBuilderTemplate, which
  // seeded starterTemplate(). An exported "use server" function is a live
  // endpoint whether or not a page renders a form for it, so removing the UI
  // was never enough.
  const actions = read("src/app/actions/docbuilder.ts");
  assert.doesNotMatch(actions, /export async function createBuilderTemplate/);
  assert.doesNotMatch(actions, /export async function saveBuilderData/);

  // blocks.ts is the retired format's type reference and nothing else. Asserting
  // "no runtime export" rather than "no starterTemplate" keeps the prose that
  // explains the removal from tripping this, and also catches the next factory.
  const legacyBlocks = read("src/lib/docbuilder/blocks.ts");
  assert.doesNotMatch(legacyBlocks, /^export (async )?function |^export const /m, "blocks.ts must export types only");
});

test("the template loaders all accept both formats", () => {
  // A single missed call site is a template that still opens blank.
  for (const [file, pattern] of [
    ["src/app/doc-editor/[id]/page.tsx", /readTemplateDocument\(template\.data/],
    ["src/lib/doceditor/generate.ts", /readTemplateDocument\(tpl\.data/],
    ["src/lib/signing/autoEnvelope.ts", /readTemplateDocument\(template\.data/],
    ["src/app/actions/doceditor.ts", /readTemplateDocument\(binding\.template\.data/],
    ["src/lib/docbuilder/store.ts", /readTemplateDocument\(row\.data\)/],
  ] as const) {
    assert.match(read(file), pattern, `${file} still loads templates with the strict parser`);
  }
});
