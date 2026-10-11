import assert from "node:assert/strict";
import { test } from "node:test";
import { blockBoxCss, boxCssText } from "../src/lib/doceditor/blockBox";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { renderDocumentHtml, renderSigningSheets } from "../src/lib/doceditor/serialize";
import type { DocumentBlock } from "../src/lib/doceditor/model";

/**
 * One function decides a block's box and type styling for every surface. These
 * are its rules, and the proof that the PDF still prints what it always did.
 */

const text = (settings: DocumentBlock["settings"]): DocumentBlock => ({ ...newBlock("text"), settings } as DocumentBlock);

test("the flow wrapper's style is byte-for-byte what the PDF emitted before", () => {
  assert.equal(boxCssText(blockBoxCss(text({}), "flow")), "");
  assert.equal(boxCssText(blockBoxCss(text({ width: 100 }), "flow")), "");
  assert.equal(boxCssText(blockBoxCss(text({ width: 60 }), "flow")), "width:60%;margin:0 auto 0 0;");
  assert.equal(boxCssText(blockBoxCss(text({ width: 60, horizontalAlignment: "right" }), "flow")), "width:60%;margin:0 0 0 auto;");
  assert.equal(boxCssText(blockBoxCss(text({ width: 60, horizontalAlignment: "centre" }), "flow")), "width:60%;margin:0 auto;");
  assert.equal(boxCssText(blockBoxCss(text({ width: 50, fontScale: 1.25, textAlign: "centre" }), "flow")), "width:50%;margin:0 auto 0 0;font-size:1.25em;text-align:center;");
  assert.equal(boxCssText(blockBoxCss(text({ fontScale: 1 }), "flow")), "", "a scale of 1 is no scale");
});

test("a freely placed block keeps its text size and alignment, and takes no width from the flow", () => {
  assert.deepEqual(blockBoxCss(text({ width: 40, horizontalAlignment: "right", fontScale: 0.8, textAlign: "right" }), "floating"), { fontSize: "0.8em", textAlign: "right" });
  assert.deepEqual(blockBoxCss(text({}), "floating"), {});
});

test("the total band is never scaled by the wrapper — it scales itself", () => {
  const band = { ...newBlock("totalBand"), settings: { fontScale: 0.7 } } as DocumentBlock;
  assert.equal(blockBoxCss(band, "flow").fontSize, undefined);
  assert.equal(blockBoxCss(band, "floating").fontSize, undefined);
});

function docWithFloat(settings: DocumentBlock["settings"]) {
  const doc = blankDocument("Test");
  doc.pages[0].floatingBlocks.push({ id: "f1", x: 100, y: 200, width: 300, block: { ...text(settings), id: "b1" } as DocumentBlock });
  return doc;
}

test("PDF and signing sheets: a floated block with no type settings renders exactly as before (no wrapper)", () => {
  const doc = docWithFloat({});
  const margin = doc.style.margin;
  const html = renderDocumentHtml(doc, {} as never);
  assert.match(html, new RegExp(`<div style="position:absolute;left:${100 - margin}px;top:${200 - margin}px;width:300px"><div style="">`));
  const sheets = renderSigningSheets(doc, {} as never);
  assert.match(sheets.pages[0], /<div style="position:absolute;left:100px;top:200px;width:300px"><div style="">/);
});

test("PDF and signing sheets: a floated block's text size and alignment are now applied", () => {
  const doc = docWithFloat({ fontScale: 1.5, textAlign: "centre" });
  for (const html of [renderDocumentHtml(doc, {} as never), renderSigningSheets(doc, {} as never).pages[0]]) {
    assert.match(html, /width:300px"><div style="font-size:1\.5em;text-align:center;"><div style="">/);
  }
});
