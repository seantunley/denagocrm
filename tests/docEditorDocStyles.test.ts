import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { activePreset, docType, docTypeCss, recolour, STYLE_PRESETS } from "../src/lib/doceditor/docStyles";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";
import { blockPreviewHtml, renderDocumentHtml, renderSigningSheets } from "../src/lib/doceditor/serialize";
import { STANDARD_TEMPLATE_KEYS, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";

/** The document's own type and colours: one definition for print, signing and the editor page. */

const withBlocks = (...blocks: DocumentBlock[]): DocumentModel => {
  const doc = blankDocument("Styles");
  doc.pages[0].rows[0].columns[0].blocks = blocks;
  return doc;
};

test("a document with no type settings prints the values it always did", () => {
  const doc = blankDocument("Plain");
  assert.deepEqual(
    { ...docType(doc.style), font: undefined },
    { font: undefined, body: "11pt", lineHeight: "1.5", text: "#1e293b", ink: "#020617", accent: "#ea580c", h1: "20pt", h2: "15pt", h3: "12pt", headingFont: "" },
  );
  const html = renderDocumentHtml(doc, null);
  assert.match(html, /font-size: 11pt; line-height: 1\.5; color: #1e293b; margin: 0;/);
  assert.match(html, /h1 \{ font-size: 20pt; margin: 0 0 8px; color: #020617; \}/);
  assert.match(html, /h3 \{ font-size: 12pt; margin: 10px 0 4px; color: #020617; \}/);
  const sheet = renderSigningSheets(doc, null).css;
  assert.match(sheet, /font-size:11pt; line-height:1\.5; color:#1e293b;/);
  assert.match(sheet, /\.sg-sheet h2 \{ font-size:15pt; margin:12px 0 6px; color:#020617; \}/);
});

test("type settings reach the printed page, the signing sheet and the editor page alike", () => {
  const doc = blankDocument("Set");
  doc.style = { ...doc.style, bodySize: 9.5, lineHeight: 1.35, textColor: "#111827", headingFont: "serif" };
  for (const css of [renderDocumentHtml(doc, null), renderSigningSheets(doc, null).css, docTypeCss(doc.style, ".doc-canvas")]) {
    const flat = css.replace(/:\s+/g, ":");
    assert.match(flat, /font-size:9\.5pt; line-height:1\.35; color:#111827;/);
    assert.match(flat, /font-size:17\.27pt;[^}]*font-family:Georgia/, "headings keep their proportion and take the heading face");
  }
  // The editor page names its own copy of the sans face, and only that changes.
  assert.match(docTypeCss(blankDocument("x").style, ".doc-canvas", "var(--font-geist-sans)"), /\.doc-canvas \{ font-family:var\(--font-geist-sans\);/);
});

test("type settings are bounded and a colour is a colour", () => {
  const doc = blankDocument("Bounds");
  assert.equal(docType({ ...doc.style, bodySize: 400, lineHeight: 0.1 }).body, "14pt");
  assert.equal(docType({ ...doc.style, bodySize: 400, lineHeight: 0.1 }).lineHeight, "1.1");
  const raw = JSON.parse(JSON.stringify(doc));
  raw.style.textColor = `#fff" onmouseover="alert(1)" x="`;
  raw.style.headingFont = "Comic Sans; background:url(x)";
  assert.equal(documentSchema.safeParse(raw).success, false, "a face is one of a fixed list");
  // The editor page's own rules are built from checked colours too, whatever they are handed.
  const hostile = docTypeCss({ ...doc.style, ink: "red} body{display:none", accent: `#fff" onload="x`, textColor: "url(x)" }, ".doc-canvas");
  assert.doesNotMatch(hostile, /display:none|onload|url\(/);
  raw.style.headingFont = "serif";
  assert.equal(documentSchema.parse(raw).style.textColor, undefined, "an unsafe colour is dropped");
});

test("the presets set type only — never a colour — and the matching one is recognised", () => {
  const doc = blankDocument("Presets");
  assert.equal(activePreset(doc.style), "modern", "a new document is the Modern preset");
  for (const preset of STYLE_PRESETS) {
    assert.deepEqual(Object.keys(preset.style).sort(), ["bodySize", "fontFamily", "headingFont", "lineHeight"]);
    const styled = documentSchema.parse({ ...doc, style: { ...doc.style, ...preset.style } }).style;
    assert.equal(activePreset(styled), preset.key);
    assert.equal(styled.accent, doc.style.accent);
  }
  assert.equal(activePreset({ ...doc.style, bodySize: 12.5 }), null);
});

test("changing a brand colour repaints the blocks drawn in it and leaves the others", () => {
  const banner = { ...newBlock("banner"), id: "banner" } as Extract<DocumentBlock, { type: "banner" }>;
  const mine = { ...newBlock("infoCard"), id: "mine", accent: "#16a34a" } as Extract<DocumentBlock, { type: "infoCard" }>;
  const boxed = { ...newBlock("text"), id: "boxed", settings: { borderColor: "#EA580C", background: "#ffffff" } } as DocumentBlock;
  const inside = { ...newBlock("totalBand"), id: "inside" } as DocumentBlock;
  const cond = { ...newBlock("conditional"), id: "cond", blocks: [inside] } as DocumentBlock;
  const doc = withBlocks(banner, mine, boxed, cond);
  doc.pages[0].floatingBlocks.push({ id: "f", x: 10, y: 10, width: 200, block: { ...newBlock("footer"), id: "floaty", variant: "simple" } as DocumentBlock });

  const next = recolour(doc, "accent", "#0ea5e9");
  const blocks = next.pages[0].rows[0].columns[0].blocks as (DocumentBlock & Record<string, unknown>)[];
  assert.equal(next.style.accent, "#0ea5e9");
  assert.equal(blocks[0].accent, "#0ea5e9", "a block in the old accent follows");
  assert.equal(blocks[0].bg, "#020617", "its dark fill is not the accent, and stays");
  assert.equal(blocks[1].accent, "#16a34a", "a block coloured on purpose stays");
  assert.equal(blocks[2].settings.borderColor, "#0ea5e9", "a border in the old accent follows, whatever its letter case");
  assert.equal((blocks[3] as unknown as { blocks: Record<string, unknown>[] }).blocks[0].color, "#0ea5e9", "inside a conditional too");
  assert.equal((next.pages[0].floatingBlocks[0].block as Record<string, unknown>).accent, "#0ea5e9", "and a freely placed block");
  assert.equal(doc.style.accent, "#ea580c", "the original document is untouched");

  const dark = recolour(next, "ink", "#1e3a8a");
  assert.equal((dark.pages[0].rows[0].columns[0].blocks[0] as Record<string, unknown>).bg, "#1e3a8a");
  assert.equal(recolour(doc, "accent", `red" onload="x`), doc, "a value that is not a colour changes nothing");
  assert.ok(documentSchema.safeParse(dark).success);
});

test("the editor page draws the standard blocks with the print renderer, at the print's sizes", () => {
  const style = blankDocument("x").style;
  const env = { company: { name: "Acme Carts", phone: "021 555 0100" }, logo: undefined };
  const card = blockPreviewHtml(newBlock("infoCard"), style, env);
  assert.match(card, /font-size:12pt/, "points, as printed — the page used to draw this at 13px");
  assert.match(card, /\{\{customer\.name\}\}/, "a merge field stays as written");
  assert.match(blockPreviewHtml(newBlock("lineItems"), style, env), /Sample item/);
  assert.match(blockPreviewHtml(newBlock("banner"), style, env), /ACME CARTS/);
  assert.match(blockPreviewHtml({ ...newBlock("footer"), variant: "brand" } as DocumentBlock, style, env), /021 555 0100/);

  const view = readFileSync("src/components/doceditor/BlockView.tsx", "utf8");
  assert.match(view, /case "divider": case "banner": case "infoCard": case "totalBand": case "terms": case "footer": case "handoverChecklist":\s*return <PrintedBlock block=\{block\} \/>;/);
  assert.doesNotMatch(view, /function BannerView|computePricing/, "the hand-drawn copies are gone");
  const canvas = readFileSync("src/components/doceditor/Canvas.tsx", "utf8");
  assert.match(canvas, /docTypeCss\(doc\.style, "\.doc-canvas"/);
  assert.match(readFileSync("src/components/doceditor/FloatingLayer.tsx", "utf8"), /"doc-canvas"/, "a freely placed block takes the document's type too");
});

test("no standard layout's output changed", () => {
  // The type rules are filled from docType; with nothing set they must be the literal rules they replaced.
  for (const key of STANDARD_TEMPLATE_KEYS) {
    const html = renderDocumentHtml(standardTemplateFor(key), null);
    assert.match(html, /body \{ font-family: [^;]+; font-size: 11pt; line-height: 1\.5; color: #1e293b; margin: 0; -webkit-font-smoothing: antialiased; \}/, key);
    assert.match(html, /h2 \{ font-size: 15pt; margin: 12px 0 6px; color: #[0-9a-f]{6}; \}/i, key);
  }
});
