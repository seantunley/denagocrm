import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { blankDocument, newBlock, newOverlayField, newPage, newRow, newColumn } from "../src/lib/doceditor/factory";
import { documentSchema, pageMargin, pageSizeOf, PAGE_SIZES, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";
import { renderDocumentHtml, renderSigningSheets, type StampField } from "../src/lib/doceditor/serialize";
import { pageBox } from "../src/lib/doceditor/arrange";
import { designWarnings } from "../src/lib/doceditor/designCheck";

/** Landscape pages, and a page with a margin of its own — and where things placed by hand land on each. */

const field = (x: number, y: number) => newOverlayField("signature", { id: `f-${x}-${y}`, recipientId: "r1", anchor: { mode: "page", blockId: null, x, y }, width: 200, height: 50 });
const float = (x: number, y: number) => ({ id: `fb-${x}`, x, y, width: 240, block: { ...newBlock("callout"), id: `b-${x}` } as DocumentBlock });
const textPage = () => newPage([newRow([newColumn(100, [newBlock("text")])])]);

/** Page 1: a cover with no margin. Page 2: the document's 48px. Page 3: 96px. Each with a field and a block at (300, 400). */
function mixed(): DocumentModel {
  const doc = blankDocument("Geometry");
  const pages = [0, undefined, 96].map((margin) => ({ ...textPage(), ...(margin === undefined ? {} : { margin }), overlayFields: [field(300, 400)], floatingBlocks: [float(300, 400)] }));
  return { ...doc, pages };
}
const stamps: StampField[] = [0, 1, 2].map((page) => ({ page, x: 300, y: 400, width: 200, height: 50, kind: "text", text: `signed-${page}` }));

test("a document that sets neither is laid out exactly as before", () => {
  const doc = blankDocument("Plain");
  assert.deepEqual(pageSizeOf(doc.style), PAGE_SIZES.A4);
  assert.equal(pageMargin(doc, doc.pages[0]), 48);
  const html = renderDocumentHtml(doc, null);
  assert.match(html, /@page \{ size: A4; margin: 48px; \}\n/);
  assert.match(html, /<div class="doc-page" style="position:relative;display:flow-root;min-height:calc\(297mm - 96px\);">/);
  assert.doesNotMatch(html, /pm-\d|landscape|page:/);
  assert.deepEqual([renderSigningSheets(doc, null).width, renderSigningSheets(doc, null).height], [794, 1123]);
});

test("landscape turns the paper for the editor, the signing sheet and the printer alike", () => {
  const doc = blankDocument("Wide");
  doc.style = { ...doc.style, orientation: "landscape" };
  assert.deepEqual(pageSizeOf(doc.style), { w: 1123, h: 794, cssH: "210mm" });
  assert.deepEqual(pageSizeOf({ pageSize: "Letter", orientation: "landscape" }), { w: 1056, h: 816, cssH: "8.5in" });
  assert.deepEqual(pageSizeOf({ pageSize: "Email", orientation: "landscape" }), PAGE_SIZES.Email, "an email is a card, not paper");
  const html = renderDocumentHtml(doc, null);
  assert.match(html, /@page \{ size: A4 landscape; margin: 48px; \}/);
  assert.match(html, /min-height:calc\(210mm - 96px\)/, "the printed page box is the turned sheet's height");
  assert.match(html, /\.doc-page \{\s*width: 1123px;/);
  const sheets = renderSigningSheets(doc, null);
  assert.deepEqual([sheets.width, sheets.height], [1123, 794]);
  assert.deepEqual(pageBox(doc), { x: 48, y: 48, w: 1123 - 96, h: 794 - 96 });
  // What fits on the turned sheet is not flagged; what only fitted on the upright one is.
  doc.pages[0].overlayFields = [field(850, 600), field(300, 760)];
  assert.deepEqual(designWarnings(doc).filter((w) => w.code === "field-off-page").map((w) => w.fieldId), ["f-300-760"]);
});

test("a page with its own margin: everything placed by hand is shifted by THAT page's margin in the PDF", () => {
  const doc = mixed();
  assert.deepEqual(doc.pages.map((p) => pageMargin(doc, p)), [0, 48, 96]);
  const html = renderDocumentHtml(doc, null);
  const pages = html.split('<div class="doc-page').slice(1);
  assert.equal(pages.length, 3);
  // Sheet (300, 400) inside a content box that starts at the page's own margin.
  for (const [i, margin] of [0, 48, 96].entries()) {
    assert.ok(pages[i].includes(`position:absolute;left:${300 - margin}px;top:${400 - margin}px;width:200px;height:50px;border:1.5px dashed`), `page ${i + 1}: the signing field`);
    assert.ok(pages[i].includes(`position:absolute;left:${300 - margin}px;top:${400 - margin}px;width:240px">`), `page ${i + 1}: the freely placed block`);
    assert.ok(pages[i].includes(`min-height:calc(297mm - ${margin * 2}px)`), `page ${i + 1}: the page box`);
  }
  // The printer is told each margin through a named page; the document's own page needs no name.
  assert.match(html, /@page \{ size: A4; margin: 48px; \} @page pm-0 \{ margin: 0px; \} @page pm-96 \{ margin: 96px; \}/);
  assert.ok(pages[0].startsWith(' pm-0" style="page:pm-0;position:relative;'));
  assert.ok(pages[1].startsWith('" style="position:relative;'));
  assert.ok(pages[2].startsWith(' pm-96" style="page:pm-96;position:relative;'));
  // On screen, where the margin is drawn as padding, each page is inset by its own.
  assert.match(html, /\.doc-page\.pm-96 \{ padding: 96px; \}\s*\.doc-page\.pm-96 > \[style\*="position:absolute"\] \{ margin: 96px 0 0 96px; \}/);
});

test("signed values are stamped by the same rule — on the page they were signed on", () => {
  const html = renderDocumentHtml(mixed(), null, undefined, { stampedFields: stamps });
  const pages = html.split('<div class="doc-page').slice(1);
  for (const [i, margin] of [0, 48, 96].entries()) {
    assert.ok(pages[i].includes(`position:absolute;left:${300 - margin}px;top:${400 - margin}px;width:200px;height:50px;display:flex;align-items:flex-end;`), `page ${i + 1}: the stamp`);
    assert.ok(pages[i].includes(`>signed-${i}</div>`), `page ${i + 1}: its own value`);
    assert.doesNotMatch(pages[i], /border:1\.5px dashed/, "the empty template box is gone once stamped");
  }
});

test("the signing sheet keeps sheet-edge coordinates and insets each page's content by its own margin", () => {
  const sheets = renderSigningSheets(mixed(), null);
  for (const [i, margin] of [0, 48, 96].entries()) {
    assert.ok(sheets.pages[i].startsWith(`<div style="position:absolute;inset:0;padding:${margin}px">`), `page ${i + 1}`);
    assert.ok(sheets.pages[i].includes(`position:absolute;left:300px;top:400px;width:240px">`), "a freely placed block sits at its sheet position whatever the margin");
  }
  assert.equal(sheets.margin, 48, "the document's margin is still what is reported");
});

test("a margin equal to the document's is no margin of its own; a silly one is bounded", () => {
  const doc = blankDocument("Same");
  doc.pages[0].margin = 48;
  assert.doesNotMatch(renderDocumentHtml(doc, null), /pm-48|page:/);
  doc.pages[0].margin = 99999;
  assert.equal(pageMargin(doc, doc.pages[0]), 200);
  doc.pages[0].margin = -5;
  assert.equal(pageMargin(doc, doc.pages[0]), 0);
  assert.deepEqual(pageBox(doc, doc.pages[0]), { x: 0, y: 0, w: 794, h: 1123 });
});

test("the settings are fixed choices, old documents load, and the editor asks the same two functions", () => {
  const raw = JSON.parse(JSON.stringify(mixed()));
  assert.ok(documentSchema.safeParse(raw).success);
  raw.style.orientation = "landscape; size: 1px";
  assert.equal(documentSchema.safeParse(raw).success, false);
  raw.style.orientation = "landscape";
  raw.pages[0].margin = "12px; x";
  assert.equal(documentSchema.safeParse(raw).success, false, "a margin is a number");
  assert.equal(documentSchema.parse(JSON.parse(JSON.stringify(blankDocument("Old")))).style.orientation, undefined);

  const canvas = readFileSync("src/components/doceditor/Canvas.tsx", "utf8");
  assert.match(canvas, /const size = pageSizeOf\(doc\.style\);/);
  assert.match(canvas, /margin=\{pageMargin\(doc, page\)\}/);
  // Nothing reads the paper size except through pageSizeOf — a second reader is how the editor and the PDF would come to disagree.
  for (const file of ["src/lib/doceditor/serialize.ts", "src/lib/doceditor/arrange.ts", "src/lib/doceditor/designCheck.ts", "src/components/doceditor/Canvas.tsx"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /PAGE_SIZES\[/, file);
  }
  assert.doesNotMatch(readFileSync("src/lib/doceditor/serialize.ts", "utf8").split("function pageHtml")[1].split("\nfunction ")[0], /doc\.style\.margin/, "a page is printed with its own margin throughout");
});
