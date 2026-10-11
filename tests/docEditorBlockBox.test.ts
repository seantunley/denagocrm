import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { blockBoxCss, boxCssText, columnNeedsStretch, pickStyle, styleCount, withoutStyle, FIXED_GEOMETRY } from "../src/lib/doceditor/blockBox";
import { blankDocument, newBlock, newColumn, newRow } from "../src/lib/doceditor/factory";
import { renderDocumentHtml, renderSigningSheets } from "../src/lib/doceditor/serialize";
import { documentSchema, type DocumentBlock } from "../src/lib/doceditor/model";

/**
 * One function decides a block's box and type styling for every surface. These
 * are its rules, and the proof that the PDF still prints what it always did.
 */

const text = (settings: DocumentBlock["settings"]): DocumentBlock => ({ ...newBlock("text"), settings } as DocumentBlock);
const css = (settings: DocumentBlock["settings"], placement: "flow" | "floating" = "flow") => boxCssText(blockBoxCss(text(settings), placement));

test("the flow wrapper's style is byte-for-byte what the PDF emitted before", () => {
  assert.equal(css({}), "");
  assert.equal(css({ width: 100 }), "");
  assert.equal(css({ width: 60 }), "width:60%;margin:0 auto 0 0;");
  assert.equal(css({ width: 60, horizontalAlignment: "right" }), "width:60%;margin:0 0 0 auto;");
  assert.equal(css({ width: 60, horizontalAlignment: "centre" }), "width:60%;margin:0 auto;");
  assert.equal(css({ width: 50, fontScale: 1.25, textAlign: "centre" }), "width:50%;margin:0 auto 0 0;font-size:1.25em;text-align:center;");
  assert.equal(css({ fontScale: 1 }), "", "a scale of 1 is no scale");
});

test("a freely placed block keeps its text size and alignment, and takes no width from the flow", () => {
  const box = blockBoxCss(text({ width: 40, horizontalAlignment: "right", fontScale: 0.8, textAlign: "right", margin: { top: 20 }, verticalAlignment: "bottom" }), "floating");
  assert.deepEqual(box.outer, {}, "a floated block has its own x / y / width");
  assert.deepEqual(box.inner, { fontSize: "0.8em", textAlign: "right" });
  assert.deepEqual(blockBoxCss(text({}), "floating"), { outer: {}, inner: {} });
});

test("the total band is never scaled by the wrapper — it scales itself", () => {
  const band = { ...newBlock("totalBand"), settings: { fontScale: 0.7 } } as DocumentBlock;
  assert.equal(blockBoxCss(band, "flow").inner.fontSize, undefined);
  assert.equal(blockBoxCss(band, "floating").inner.fontSize, undefined);
});

test("padding, fill, border, corners and type are the same on a flowed and a freely placed block", () => {
  const settings = { padding: { top: 8, right: 12, bottom: 8, left: 12 }, background: "#f1f5f9", borderColor: "#0f172a", borderWidth: 2, radius: 6, fontWeight: "bold" as const, lineHeight: 1.8, letterSpacing: 0.5 };
  const want = "padding:8px 12px 8px 12px;background:#f1f5f9;-webkit-print-color-adjust:exact;print-color-adjust:exact;border:2px solid #0f172a;border-radius:6px;box-sizing:border-box;line-height:1.8;letter-spacing:0.5px;font-weight:800;";
  assert.equal(css(settings, "flow"), want);
  assert.equal(css(settings, "floating"), want);
});

test("space above and below, with and without a narrow width", () => {
  assert.equal(css({ margin: { top: 24, bottom: 8 } }), "margin:24px 0 8px 0;");
  assert.equal(css({ width: 50, margin: { top: 24, bottom: 8 } }), "width:50%;margin:24px auto 8px 0;");
  assert.equal(css({ width: 50, horizontalAlignment: "right", margin: { top: 10 } }), "width:50%;margin:10px 0 0px auto;");
  assert.equal(css({ width: 50, horizontalAlignment: "centre", margin: { bottom: 10 } }), "width:50%;margin:0px auto 10px auto;");
});

test("resting at the middle or the bottom makes the column stretch; the top (and everything saved before) does not", () => {
  assert.equal(css({ verticalAlignment: "bottom" }), "margin-top:auto;");
  assert.equal(css({ verticalAlignment: "middle" }), "margin-top:auto;margin-bottom:auto;");
  assert.equal(css({ verticalAlignment: "top" }), "");
  assert.equal(columnNeedsStretch([text({}), text({ verticalAlignment: "top" })]), false);
  assert.equal(columnNeedsStretch([text({}), text({ verticalAlignment: "bottom" })]), true);
});

test("numbers are clamped and colours checked here too — this string goes into a style attribute", () => {
  const attack = `#fff;background:url(javascript:alert(1))`;
  const box = blockBoxCss(text({ padding: { top: 9999, left: -50 }, borderWidth: 999, radius: 999, lineHeight: 99, letterSpacing: 99, background: attack, borderColor: `red" onmouseover="x` } as never), "flow");
  assert.equal(box.inner.padding, "200px 0px 0px 0px");
  assert.equal(box.inner.border, "12px solid #cbd5e1", "an unsafe border colour falls back, the border is still drawn");
  assert.equal(box.inner.borderRadius, "60px");
  assert.equal(box.inner.lineHeight, "3");
  assert.equal(box.inner.letterSpacing, "10px");
  assert.equal(box.inner.background, undefined);
  assert.doesNotMatch(boxCssText(box), /javascript|onmouseover|"/);
  // …and the schema drops the same values on the way in.
  const doc = JSON.parse(JSON.stringify(blankDocument("x")));
  doc.pages[0].rows[0].columns[0].blocks[0].settings = { background: attack, borderColor: `red" onmouseover="x`, borderWidth: 2 };
  const parsed = documentSchema.parse(doc).pages[0].rows[0].columns[0].blocks[0].settings;
  assert.equal(parsed.background, undefined);
  assert.equal(parsed.borderColor, undefined);
  assert.equal(parsed.borderWidth, 2);
});

test("fixed-geometry blocks take type settings only — padding or a border would move a signature line", () => {
  for (const type of ["acceptance", "footerBand", "showcaseHeader"] as const) {
    assert.ok(FIXED_GEOMETRY.has(type));
    const block = { ...newBlock(type), settings: { padding: { top: 20, right: 20, bottom: 20, left: 20 }, margin: { top: 30 }, background: "#000000", borderWidth: 3, radius: 9, verticalAlignment: "bottom", fontWeight: "bold", textAlign: "centre" } } as DocumentBlock;
    assert.equal(boxCssText(blockBoxCss(block, "flow")), "text-align:center;font-weight:800;", type);
    assert.equal(boxCssText(blockBoxCss(block, "floating")), "text-align:center;font-weight:800;", type);
  }
});

function docWithFloat(settings: DocumentBlock["settings"]) {
  const doc = blankDocument("Test");
  doc.pages[0].floatingBlocks.push({ id: "f1", x: 100, y: 200, width: 300, block: { ...text(settings), id: "b1" } as DocumentBlock });
  return doc;
}

test("PDF and signing sheets: a floated block with no settings renders exactly as before (no wrapper)", () => {
  const doc = docWithFloat({});
  const margin = doc.style.margin;
  const html = renderDocumentHtml(doc, {} as never);
  assert.match(html, new RegExp(`<div style="position:absolute;left:${100 - margin}px;top:${200 - margin}px;width:300px"><div style="">`));
  const sheets = renderSigningSheets(doc, {} as never);
  assert.match(sheets.pages[0], /<div style="position:absolute;left:100px;top:200px;width:300px"><div style="">/);
});

test("PDF and signing sheets: a floated block's settings are applied", () => {
  const doc = docWithFloat({ fontScale: 1.5, textAlign: "centre", padding: { top: 4, right: 4, bottom: 4, left: 4 }, background: "#fef3c7" });
  for (const html of [renderDocumentHtml(doc, {} as never), renderSigningSheets(doc, {} as never).pages[0]]) {
    assert.match(html, /width:300px"><div style="font-size:1\.5em;text-align:center;padding:4px 4px 4px 4px;background:#fef3c7;[^"]*box-sizing:border-box;"><div style="">/);
  }
});

test("PDF: a styled block in the flow gets one wrapper; a hidden one prints nothing, not an empty box", () => {
  const doc = blankDocument("Flow");
  const styled = { ...text({ borderWidth: 1, borderColor: "#0f172a", padding: { top: 10, right: 10, bottom: 10, left: 10 } }), id: "styled" } as DocumentBlock;
  const hidden = { ...text({ borderWidth: 1, background: "#ff0000" }), id: "hidden", hidden: true } as DocumentBlock;
  doc.pages[0].rows = [newRow([newColumn(100, [styled, hidden])])];
  const html = renderDocumentHtml(doc, {} as never);
  assert.equal((html.match(/border:1px solid #0f172a;/g) ?? []).length, 1);
  assert.doesNotMatch(html, /background:#ff0000/);
});

test("PDF: a column becomes a flex column only when a block in it rests lower; otherwise it is the old markup", () => {
  const plain = blankDocument("Plain");
  assert.match(renderDocumentHtml(plain, {} as never), /<div style="min-width:0">/);
  assert.doesNotMatch(renderDocumentHtml(plain, {} as never), /flex-direction:column/);
  const doc = blankDocument("Cols");
  doc.pages[0].rows = [newRow([newColumn(50, [text({})]), newColumn(50, [text({ verticalAlignment: "bottom" })])])];
  const html = renderDocumentHtml(doc, {} as never);
  assert.equal((html.match(/<div style="min-width:0;display:flex;flex-direction:column">/g) ?? []).length, 1);
  assert.equal((html.match(/<div style="min-width:0">/g) ?? []).length, 1);
});

test("copy style takes the look and leaves where the block sits; reset keeps only where it sits", () => {
  const settings = { width: 60, horizontalAlignment: "right" as const, fontScale: 1.2, padding: { top: 8 }, background: "#eeeeee", borderWidth: 1 };
  assert.deepEqual(pickStyle(settings), { fontScale: 1.2, padding: { top: 8 }, background: "#eeeeee", borderWidth: 1 });
  assert.deepEqual(withoutStyle(settings), { width: 60, horizontalAlignment: "right" });
  assert.equal(styleCount(settings), 4);
  assert.equal(styleCount({ width: 60 }), 0);
});

test("the editor page takes the same styling from the same function, and every document block gets the design panel", () => {
  const canvas = readFileSync("src/components/doceditor/Canvas.tsx", "utf8");
  assert.match(canvas, /const box = blockBoxCss\(block, "flow"\);/);
  assert.match(canvas, /const boxStyle: React\.CSSProperties = \{ \.\.\.box\.outer \};/);
  assert.match(canvas, /<div style=\{\{ \.\.\.box\.inner,[\s\S]{0,120}\}\}>\s*<BlockView block=\{block\} active=\{active\} \/>/);
  assert.match(canvas, /columnNeedsStretch\(col\.blocks\)/);
  assert.match(readFileSync("src/components/doceditor/FloatingLayer.tsx", "utf8"), /blockBoxCss\(fb\.block, "floating"\)\.inner/);
  const panel = readFileSync("src/components/doceditor/PropertiesPanel.tsx", "utf8");
  assert.match(panel, /<DesignSection block=\{block\} floating=\{floating\} \/>/);
  const design = readFileSync("src/components/doceditor/DesignSection.tsx", "utf8");
  for (const control of ["Padding (inside)", "Space outside", "Fill", "Border", "Line spacing", "Letter spacing", "Copy style", "Paste style", "Reset style"]) assert.ok(design.includes(control), control);
  assert.match(design, /\{count\} changed/, "an override is never invisible");
});
