import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { designWarnings, summariseWarnings } from "../src/lib/doceditor/designCheck";
import { blankDocument, newBlock, newOverlayField, newPage } from "../src/lib/doceditor/factory";
import { showcaseQuoteTemplate, STANDARD_TEMPLATE_KEYS, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { PAGE_SIZES, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";

/** The design check: what it flags, and — as important — what it leaves alone. */

const codes = (doc: DocumentModel, measured = {}) => designWarnings(doc, measured).map((w) => w.code).sort();
const field = (over: Parameters<typeof newOverlayField>[1]) => newOverlayField("signature", { recipientId: "r1", ...over });

test("the standard layouts raise nothing — a check that cries wolf on the built-in documents is useless", () => {
  for (const key of STANDARD_TEMPLATE_KEYS) {
    const warnings = designWarnings(standardTemplateFor(key));
    // The built-in layouts ship with their signing fields unassigned until a send names the signer; that is not a flaw.
    const real = warnings.filter((w) => w.code !== "field-unassigned");
    assert.deepEqual(real.map((w) => `${w.code}: ${w.message}`), [], key);
  }
  assert.deepEqual(codes(blankDocument("Blank")), []);
});

test("signing fields: overlapping, off the sheet, and unassigned", () => {
  const doc = blankDocument("Fields");
  const size = PAGE_SIZES[doc.style.pageSize];
  doc.pages[0].overlayFields = [
    field({ id: "a", anchor: { mode: "page", blockId: null, x: 100, y: 100 }, width: 200, height: 50 }),
    field({ id: "b", anchor: { mode: "page", blockId: null, x: 150, y: 110 }, width: 200, height: 50 }),
    field({ id: "c", anchor: { mode: "page", blockId: null, x: size.w - 40, y: 300 }, width: 200, height: 50 }),
    field({ id: "d", anchor: { mode: "page", blockId: null, x: 100, y: 500 }, width: 200, height: 50, recipientId: null }),
    field({ id: "e", anchor: { mode: "page", blockId: null, x: 360, y: 200 }, width: 100, height: 50 }),
  ];
  const warnings = designWarnings(doc);
  assert.deepEqual(warnings.map((w) => `${w.code}:${w.fieldId}`).sort(), ["field-off-page:c", "field-unassigned:d", "fields-overlap:a"]);
  assert.ok(warnings.every((w) => w.page === 1));
  // Two fields that merely touch, or overlap by a sliver, are not flagged.
  doc.pages[0].overlayFields = [field({ id: "a", anchor: { mode: "page", blockId: null, x: 100, y: 100 }, width: 200, height: 50 }), field({ id: "b", anchor: { mode: "page", blockId: null, x: 295, y: 100 }, width: 200, height: 50 })];
  assert.deepEqual(codes(doc), []);
});

test("an empty page is flagged only when there are others; a page holding only a signing field is not empty", () => {
  const doc = blankDocument("Pages");
  assert.deepEqual(codes({ ...doc, pages: [newPage()] }), [], "a new document's single blank page is not a flaw");
  assert.deepEqual(codes({ ...doc, pages: [doc.pages[0], newPage()] }), ["empty-page"]);
  const withField = newPage();
  withField.overlayFields.push(field({ anchor: { mode: "page", blockId: null, x: 50, y: 50 } }));
  assert.deepEqual(codes({ ...doc, pages: [doc.pages[0], withField] }), []);
});

test("tiny text, a picture-less image and a freely placed block off the sheet", () => {
  const doc = blankDocument("Blocks");
  const tiny = { ...newBlock("text"), id: "tiny", settings: { fontScale: 0.6 } } as DocumentBlock;
  const small = { ...newBlock("text"), id: "small", settings: { fontScale: 0.8 } } as DocumentBlock;
  const noPicture = { ...newBlock("image"), id: "img" } as DocumentBlock;
  const hiddenTiny = { ...newBlock("text"), id: "hidden", hidden: true, settings: { fontScale: 0.5 } } as DocumentBlock;
  doc.pages[0].rows[0].columns[0].blocks.push(tiny, small, noPicture, hiddenTiny);
  doc.pages[0].floatingBlocks.push({ id: "f", x: PAGE_SIZES[doc.style.pageSize].w - 100, y: 100, width: 300, block: { ...newBlock("heading"), id: "floaty" } as DocumentBlock });
  assert.deepEqual(designWarnings(doc).map((w) => `${w.code}:${w.blockId}`).sort(), ["float-off-page:floaty", "image-missing:img", "tiny-text:tiny"]);
});

test("a variable in a family nothing fills is flagged; a real one — in the picker or not — never is", () => {
  const doc = blankDocument("Vars");
  const say = (text: string) => ({ ...newBlock("text"), id: `t${Math.random()}`, value: [{ type: "p", children: [{ text }] }] }) as DocumentBlock;
  doc.pages[0].rows[0].columns[0].blocks = [
    say("Dear {{customer.firstName}}, quote {{ quote.number }} is valid until {{quote.validUntil}}."),
    say("{{agreement.clauses}} {{service.nextDue}} {{vehicle}} {{items}} {{asset.bandTop}} {{date.today}}"),
    say("Dear {{custmer.name}}, the price is {{price}} and {{custmer.name}} again."),
  ];
  const unknown = designWarnings(doc).filter((w) => w.code === "unknown-variable").map((w) => w.message.match(/\{\{(.+?)\}\}/)![1]).sort();
  assert.deepEqual(unknown, ["custmer.name", "price"], "each unknown variable once per block");
});

test("what only the page can measure is passed in: a page that prints on two sheets, and a field that lands on the second", () => {
  const doc = blankDocument("Overflow");
  const size = PAGE_SIZES[doc.style.pageSize];
  doc.pages[0].overlayFields = [field({ id: "low", anchor: { mode: "page", blockId: null, x: 100, y: size.h + 40 }, width: 200, height: 50 })];
  assert.deepEqual(codes(doc), ["field-off-page"], "with one sheet, below the edge is off the page");
  assert.deepEqual(codes(doc, { sheets: { [doc.pages[0].id]: 2 } }), ["field-on-overflow", "page-overflows"]);
});

test("an email is never checked for pages, sheets or signing fields", () => {
  const doc = blankDocument("Email");
  doc.style.pageSize = "Email";
  doc.pages.push(newPage());
  doc.pages[0].overlayFields = [field({ recipientId: null, anchor: { mode: "page", blockId: null, x: -50, y: -50 } })];
  assert.deepEqual(designWarnings(doc), []);
});

test("the summary names the pages", () => {
  const doc = showcaseQuoteTemplate();
  doc.pages.push(newPage());
  const text = summariseWarnings(designWarnings(doc).filter((w) => w.code !== "field-unassigned"));
  assert.equal(text, `1 thing to check: 1 on page ${doc.pages.length}`);
  assert.equal(summariseWarnings([]), "");
});

test("the check warns in the editor and on publish, and never blocks either", () => {
  const editor = readFileSync("src/components/doceditor/DocEditor.tsx", "utf8");
  assert.match(editor, /designWarnings\(doc, \{ sheets: pageSheets \}\)/);
  assert.match(editor, /<DesignCheckPanel/);
  const publish = readFileSync("src/app/actions/docbuilder.ts", "utf8");
  assert.match(publish, /designWarnings\(/);
  // Published regardless: the warnings are returned beside ok: true, never instead of it.
  assert.match(publish, /return \{ ok: true, version, warnings \};/);
});
