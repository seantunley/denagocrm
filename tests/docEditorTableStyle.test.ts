import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { documentSchema, type DocumentBlock, type DocumentModel, type TableStyle } from "../src/lib/doceditor/model";
import { renderDocumentHtml, type RenderCtx } from "../src/lib/doceditor/serialize";
import { tableLook } from "../src/lib/doceditor/tableStyle";

/** Table style options: spacing, lines, tinted rows, repeated heading, whole rows, row kinds, column widths. */

type Table = Extract<DocumentBlock, { type: "table" }>;
const docWith = (block: DocumentBlock): DocumentModel => {
  const doc = blankDocument("Tables");
  doc.pages[0].rows[0].columns[0].blocks = [block];
  return doc;
};
const table = (over: Partial<Table> = {}): Table => ({
  ...(newBlock("table") as Table),
  columns: [{ header: "Item", align: "left", widthPct: 60 }, { header: "Amount", align: "right", widthPct: 40 }],
  rows: [{ cells: [{ value: "One" }, { value: "10" }] }, { cells: [{ value: "Two" }, { value: "20" }] }],
  ...over,
});
const bound: RenderCtx = { tokens: {}, vars: {}, bound: true, items: [{ cells: [{ value: "Cart" }, { value: "1" }, { value: "R 100,00" }, { value: "R 100,00" }], qty: 1, unitPrice: 100, lineTotal: 100 }, { cells: [{ value: "Cover" }, { value: "2" }, { value: "R 10,00" }, { value: "R 20,00" }], qty: 2, unitPrice: 10, lineTotal: 20 }] };
const html = (block: DocumentBlock, ctx: RenderCtx = null) => renderDocumentHtml(docWith(block), ctx);

test("a table nobody has styled prints exactly the markup it always did", () => {
  assert.deepEqual(
    { ...tableLook(undefined, [6, 8]), rowBg: undefined },
    { pad: "6px 8px", cellRule: "border-bottom:.5px solid #e2e8f0", borders: "rows", rowBg: undefined, thead: "", tr: "" },
  );
  const plain = html(table());
  assert.ok(plain.includes(`<table style="width:100%;border-collapse:collapse;margin:6px 0"><thead><tr><th style="text-align:left;background:#020617;color:#ffffff;padding:6px 8px;font-size:8pt;width:60%">Item</th>`));
  assert.ok(plain.includes(`<tr style="background:#fff"><td style="text-align:left;padding:6px 8px;border-bottom:.5px solid #e2e8f0;font-size:10pt">One</td>`));
  assert.ok(plain.includes(`<tr style="background:#f8fafc"><td style="text-align:left;padding:6px 8px;border-bottom:.5px solid #e2e8f0;font-size:10pt">Two</td>`));

  const items = html(newBlock("lineItems"), bound);
  assert.ok(items.includes(`<thead><tr><th style="text-align:left;background:#020617;color:#ffffff;padding:7px 9px;font-size:8pt;letter-spacing:.5px;text-transform:uppercase">Description</th>`));
  assert.ok(items.includes(`<tr style="background:#f8fafc"><td style="text-align:left;padding:7px 9px;border-bottom:.5px solid #e2e8f0">Cover</td>`));

  const pricing = html({ ...newBlock("pricing"), bound: true } as DocumentBlock, bound);
  assert.ok(pricing.includes(`<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;background:#ea580c;color:#fff;padding:7px 9px;font-size:8pt;letter-spacing:.5px;text-transform:uppercase">Item</th>`));
  assert.ok(pricing.includes(`<tr style="background:#fff"><td style="padding:7px 9px;border-bottom:.5px solid #e2e8f0"><div style="font-weight:600;color:#020617">Cart</div></td><td style="text-align:right;padding:7px 9px;border-bottom:.5px solid #e2e8f0">1</td>`));
  assert.match(pricing, /border-bottom:\.5px solid #e2e8f0;font-weight:600">/);
});

test("each style choice changes what it says and nothing else — on all three tables", () => {
  const style: TableStyle = { density: "compact", borders: "grid", zebra: false, repeatHeader: false, keepRows: true };
  for (const [name, out] of [
    ["table", html(table({ tableStyle: style }))],
    ["lineItems", html({ ...newBlock("lineItems"), tableStyle: style } as DocumentBlock, bound)],
    ["pricing", html({ ...newBlock("pricing"), bound: true, tableStyle: style } as DocumentBlock, bound)],
  ] as const) {
    assert.match(out, /<thead style="display:table-row-group">/, `${name}: the heading does not repeat`);
    assert.match(out, /<tr style="break-inside:avoid;background:#fff">/, `${name}: rows are kept whole`);
    assert.doesNotMatch(out, /background:#f8fafc"><td/, `${name}: no tinted rows`);
    assert.match(out, /padding:[34]px [89]px;border:\.5px solid #e2e8f0/, `${name}: tighter rows, a full grid`);
  }
  assert.match(html(table({ tableStyle: { density: "relaxed", borders: "none" } })), /padding:10px 8px;;font-size:10pt/);
});

test("a group heading spans the table; a subtotal is bold and ruled above", () => {
  const out = html(table({ rows: [
    { cells: [{ value: "Hardware" }, { value: "ignored" }], kind: "group" },
    { cells: [{ value: "Cart" }, { value: "100" }] },
    { cells: [{ value: "Subtotal" }, { value: "100" }], kind: "subtotal" },
  ] }));
  assert.match(out, /<td colspan="2" style="[^"]*text-transform:uppercase[^"]*">Hardware<\/td>/);
  assert.doesNotMatch(out, /ignored/, "a group heading shows its first cell only");
  assert.match(out, /font-size:10pt;font-weight:700;border-top:1px solid #94a3b8">Subtotal<\/td>/);
});

test("a line-items column can be given a width; without one it is sized by its content, as before", () => {
  const block = newBlock("lineItems") as Extract<DocumentBlock, { type: "lineItems" }>;
  const sized = { ...block, columns: block.columns.map((c, i) => (i === 0 ? { ...c, widthPct: 55 } : c)) };
  const out = html(sized, bound);
  assert.match(out, /text-transform:uppercase;width:55%">Description<\/th>/);
  assert.equal((out.match(/;width:\d+%">/g) ?? []).length, 1, "only the column that was given one");
});

test("the settings are held to fixed choices, and old documents still load", () => {
  const doc = JSON.parse(JSON.stringify(docWith(table())));
  assert.ok(documentSchema.safeParse(doc).success, "a table saved before any of this");
  doc.pages[0].rows[0].columns[0].blocks[0].tableStyle = { density: "compact; background:url(x)" };
  assert.equal(documentSchema.safeParse(doc).success, false);
  doc.pages[0].rows[0].columns[0].blocks[0].tableStyle = { borders: "grid", keepRows: true };
  doc.pages[0].rows[0].columns[0].blocks[0].rows[0].kind = "subtotal";
  assert.ok(documentSchema.safeParse(doc).success);
});

test("the editor's table uses the same look, and the controls are offered where they apply", () => {
  const view = readFileSync("src/components/doceditor/BlockView.tsx", "utf8");
  assert.match(view, /const look = tableLook\(block\.tableStyle, \[6, 8\]\);/);
  const panel = readFileSync("src/components/doceditor/PropertiesPanel.tsx", "utf8");
  assert.equal((panel.match(/<TableStyleControls /g) ?? []).length, 4, "plain table, line items, statement lines and pricing");
  // The showcase and classic line-items looks are drawn to fixed measurements the page's overflow depends on.
  assert.match(panel, /\{!block\.look \|\| block\.look === "standard" \? \(\s*<Section title="Table style">/);
  const controls = readFileSync("src/components/doceditor/TableStyleControls.tsx", "utf8");
  assert.match(controls, /onChange\(Object\.keys\(next\)\.length \? \(next as TableStyle\) : undefined\)/, "back to standard stores nothing");
});
