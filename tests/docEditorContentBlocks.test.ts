import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { qrSvg, scheduleAmounts } from "../src/lib/doceditor/contentBlocks";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { CONTENT_BLOCK_TYPES, documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";
import { blockPreviewHtml, renderDocumentHtml, renderSigningSheets, type RenderCtx } from "../src/lib/doceditor/serialize";
import { designWarnings } from "../src/lib/doceditor/designCheck";

/** The content blocks: details grid, payment schedule, comparison, callout, photo gallery, QR code. */

const docWith = (...blocks: DocumentBlock[]): DocumentModel => {
  const doc = blankDocument("Blocks");
  doc.pages[0].rows[0].columns[0].blocks = blocks;
  return doc;
};
const bound = (over: Partial<NonNullable<RenderCtx>> = {}): RenderCtx => ({
  tokens: { "customer.name": "Thandi <M>", "quote.number": "Q-1042", "company.website": "https://example.co.za" },
  items: [], vars: { quotation: { total: 100000.01 } }, bound: true, ...over,
});
const html = (block: DocumentBlock, ctx: RenderCtx = null) => renderDocumentHtml(docWith(block), ctx);
const make = <T extends DocumentBlock["type"]>(type: T, over: object = {}, preset?: string) => ({ ...newBlock(type, preset), ...over }) as Extract<DocumentBlock, { type: T }>;

test("every new block is a valid document, draws on the page, the PDF and the signing sheet, and trips no design warning", () => {
  for (const type of CONTENT_BLOCK_TYPES) {
    const doc = docWith(newBlock(type));
    assert.ok(documentSchema.safeParse(JSON.parse(JSON.stringify(doc))).success, type);
    assert.ok(html(newBlock(type)).length > 0);
    assert.ok(renderSigningSheets(doc, null).pages[0].length > 100, `${type}: on the signing sheet`);
    assert.ok(blockPreviewHtml(newBlock(type), doc.style, { company: { name: "Acme" } }).length > 50, `${type}: on the editor page`);
    assert.deepEqual(designWarnings(doc).map((w) => w.code), [], `${type}: a fresh block raises nothing`);
  }
  for (const preset of ["spec", "banking"]) assert.ok(documentSchema.safeParse(docWith(newBlock("detailsGrid", preset))).success, preset);
  assert.match(html(newBlock("detailsGrid", "banking")), /BANKING DETAILS/);
});

test("a payment schedule's shares are worked out in cents and add up to the total", () => {
  // Half of an odd number of cents: one half rounds up, the other takes what is left.
  assert.deepEqual(scheduleAmounts([{ percent: 50 }, { percent: 50 }], 10000001), [5000001, 5000000]);
  // Thirds of R100.00: 33.33 + 33.33 + the remainder — never R99.99 or R100.01.
  const thirds = scheduleAmounts([{ percent: 33.33 }, { percent: 33.33 }, { percent: 33.34 }], 10000);
  assert.deepEqual(thirds, [3333, 3333, 3334]);
  const awkward = scheduleAmounts([{ percent: 12.5 }, { percent: 37.5 }, { percent: 50 }], 99999);
  assert.equal((awkward as number[]).reduce((a, b) => a + b, 0), 99999, "the last share takes the rounding");
  // Shares that do not come to 100% are each simply their share — nothing is silently "corrected".
  assert.deepEqual(scheduleAmounts([{ percent: 30 }, { percent: 30 }], 10000), [3000, 3000]);
  // A row with a typed amount has no share, and is not the row the remainder lands on.
  assert.deepEqual(scheduleAmounts([{ percent: 60 }, {}, { percent: 40 }, {}], 1001), [601, null, 400, null]);
  assert.deepEqual(scheduleAmounts([{ percent: -5 }, { percent: Number.NaN }], 1000), [null, null]);

  const block = make("paymentSchedule");
  const out = html(block, bound());
  assert.match(out, /Deposit <span[^>]*>\(50%\)<\/span>/);
  assert.match(out, /R\s?50\s?000,01|R\s?50\s?000,00/);
  const figures = [...out.matchAll(/white-space:nowrap;vertical-align:top">R\s?([\d\s]+),(\d\d)</g)].map((m) => Number(m[1].replace(/\s/g, "")) * 100 + Number(m[2]));
  assert.equal(figures.reduce((a, b) => a + b, 0), 10000001, "what is printed adds up to the quote's total");
  // With no record there is no total: the share is shown as a share.
  assert.match(html(block), /50% of the total/);
  // A typed amount is printed as typed.
  assert.match(html(make("paymentSchedule", { rows: [{ label: "Fee", due: "", amount: "R 500 once-off" }] }), bound()), /R 500 once-off/);
});

test("merge fields fill in, are escaped, and never reach a customer unresolved", () => {
  const grid = make("detailsGrid", { items: [{ label: "Customer", value: "{{customer.name}}" }, { label: "Reg number", value: "{{vehicle.reg}}" }, { label: "Ref", value: "{{quote.number}}" }] });
  const out = html(grid, bound());
  assert.match(out, /Thandi &lt;M&gt;/, "a value is escaped");
  assert.doesNotMatch(out, /\{\{/, "no braces reach a customer");
  assert.doesNotMatch(out, /Reg number/, "a line whose value came out empty is left out");
  assert.match(html(grid), /\{\{vehicle\.reg\}\}/, "in the editor the field stays visible");
  const callout = html(make("callout", { title: `<script>alert(1)</script>`, text: "Line one\nLine two for {{customer.name}}" }), bound());
  assert.doesNotMatch(callout, /<script>/);
  assert.match(callout, /Line one<br\/>Line two for Thandi/);
});

test("a comparison draws ticks and dashes, and picks out one option", () => {
  const out = html(make("comparison"));
  assert.match(out, /color:#16a34a;font-weight:700">✓</);
  assert.match(out, /color:#cbd5e1">—</);
  assert.match(out, /border-bottom:2px solid #ea580c;background:#ea580c14/);
  assert.match(out, />24 months</);
});

test("a QR code is drawn only for a real web address, and nothing is fetched", () => {
  const svg = qrSvg("https://example.co.za/pay/Q-1042", 96);
  assert.match(svg, /^<svg [^>]*width="96"[^>]*><rect width="100%" height="100%" fill="#fff"\/><path d="(M\d+ \d+h1v1h-1z)+" fill="#000"\/><\/svg>$/);
  assert.notEqual(svg, qrSvg("https://example.co.za/pay/Q-1043", 96), "the code is the link");

  const out = html(make("qr"), bound());
  assert.match(out, /<svg /);
  assert.match(out, />https:\/\/example\.co\.za</);
  assert.doesNotMatch(out, /<img|src="http/, "no image is fetched from anywhere");
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "ftp://x.y", `https://x.y/" onload="z`, "example.co.za", "{{nothing.here}}"]) {
    const refused = html(make("qr", { url }), bound());
    assert.doesNotMatch(refused, /<svg /, `${url}: no code`);
    assert.doesNotMatch(refused, /Scan to visit us/, `${url}: a customer gets nothing rather than a label with no code`);
  }
  // In the editor, the place it will go is drawn.
  assert.match(html(make("qr", { url: "{{quote.link}}" })), /QR code — fills in from the record/);
  assert.match(html(make("qr", { size: 99999 })), /width:240px|width="240"/, "its size is bounded");
});

test("a gallery shows only pictures the page may load, cropped to one shape", () => {
  const data = "data:image/png;base64,iVBORw0KGgo=";
  const gallery = make("gallery", { columns: 2, images: [
    { src: data, alt: "Front", caption: "Front {{quote.number}}" },
    { src: "https://example.co.za/a.jpg", alt: "", caption: "" },
    { src: "http://example.co.za/insecure.jpg", alt: "", caption: "" },
    { src: `javascript:alert(1)`, alt: "", caption: "" },
    { src: "", alt: "", caption: "" },
  ] });
  const out = html(gallery, bound());
  assert.equal((out.match(/<img /g) ?? []).length, 2, "the inline picture and the https one");
  assert.doesNotMatch(out, /insecure|javascript:/);
  assert.match(out, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(out, /aspect-ratio:4 \/ 3;border-radius:6px;display:block;object-fit:cover/);
  assert.match(out, /Front Q-1042/);
  // In the editor an empty place is drawn, so there is something to click.
  assert.equal((html(gallery).match(/border:1px dashed #cbd5e1/g) ?? []).length, 3);
  // A stored upload is embedded by the same owner-checked reader as the image block's.
  assert.match(readFileSync("src/lib/doceditor/renderGlobals.ts", "utf8"), /node\.type === "gallery" && Array\.isArray\(node\.images\)[\s\S]{0,300}embedStoredImage\(image\.src\.trim\(\), owner\)/);
});

test("settings are held to their limits; a colour is a colour", () => {
  const doc = JSON.parse(JSON.stringify(docWith(make("callout"), make("gallery"), make("detailsGrid"))));
  const [callout, gallery, grid] = doc.pages[0].rows[0].columns[0].blocks;
  callout.accent = `#fff" onmouseover="alert(1)" x="`;
  assert.equal((documentSchema.parse(doc).pages[0].rows[0].columns[0].blocks[0] as { accent?: string }).accent, "#ea580c", "an unsafe colour falls back");
  gallery.aspect = "9:1; background:url(x)";
  assert.equal(documentSchema.safeParse(doc).success, false, "a shape is one of a fixed list");
  gallery.aspect = "1:1";
  callout.tone = "danger; x";
  assert.equal(documentSchema.safeParse(doc).success, false, "a kind is one of a fixed list");
  callout.tone = "warning";
  grid.columns = 400;
  const parsed = documentSchema.parse(doc);
  assert.match(renderDocumentHtml(parsed, null), /grid-template-columns:repeat\(4,minmax/, "column counts are bounded when drawn");
});

test("the editor offers them, draws them with the print renderer, and edits them in the panel", () => {
  const palette = readFileSync("src/components/doceditor/Palette.tsx", "utf8");
  for (const label of ["Label / value grid", "Specification grid", "Banking details", "Payment schedule", "Comparison table", "Callout", "Photo gallery", "QR code / link"]) assert.ok(palette.includes(`label: "${label}"`), label);
  assert.match(readFileSync("src/components/doceditor/DndController.tsx", "utf8"), /newBlock\(data\.blockType, data\.preset\)/, "a dragged preset arrives as that preset");
  assert.match(readFileSync("src/components/doceditor/BlockView.tsx", "utf8"), /case "detailsGrid": case "paymentSchedule": case "comparison": case "callout": case "gallery": case "qr":\s*return <PrintedBlock block=\{block\} \/>;/);
  assert.match(readFileSync("src/components/doceditor/PropertiesPanel.tsx", "utf8"), /<ContentBlockProps block=\{block\} \/>/);
});
