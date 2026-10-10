import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { blankDocument, newBlock, newOverlayField, newPage, newRow, newColumn } from "../src/lib/doceditor/factory";
import { duplicatePage, movePage, removePage, pageHasContent } from "../src/lib/doceditor/ops";
import { documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";

/** Pages can be deleted, duplicated and reordered; a copy shares no id with its original. */

function twoPages(): DocumentModel {
  const doc = blankDocument("Pages");
  const second = newPage([newRow([newColumn(100, [newBlock("text")])])]);
  const floated = { ...newBlock("heading"), id: "float-block" } as DocumentBlock;
  second.floatingBlocks.push({ id: "float-1", x: 60, y: 600, width: 300, block: floated });
  second.overlayFields.push(newOverlayField("signature", { id: "field-1", recipientId: "rcp-1" }));
  second.overflowGroups = [{ maxItems: 5, floatIds: ["float-1"], fieldIds: ["field-1"] }];
  return { ...doc, pages: [doc.pages[0], second] };
}

const everyId = (doc: DocumentModel): string[] => doc.pages.flatMap((p) => [
  p.id,
  ...p.rows.flatMap((r) => [r.id, ...r.columns.flatMap((c) => [c.id, ...c.blocks.map((b) => b.id)])]),
  ...p.floatingBlocks.flatMap((fb) => [fb.id, fb.block.id]),
  ...p.overlayFields.map((f) => f.id),
]);

test("duplicating a page copies everything on it and shares no id with the original", () => {
  const doc = twoPages();
  const next = duplicatePage(doc, doc.pages[1].id);
  assert.equal(next.pages.length, 3);
  assert.equal(next.pages[1].id, doc.pages[1].id, "the copy goes straight after the original");
  const copy = next.pages[2];
  assert.equal(copy.rows.length, 1);
  assert.equal(copy.floatingBlocks.length, 1);
  assert.equal(copy.overlayFields.length, 1);
  const ids = everyId(next);
  assert.equal(new Set(ids).size, ids.length, "no two things in the document share an id");
  // The copy's "move together" group points at the copy's own block and field.
  assert.deepEqual(copy.overflowGroups?.[0].floatIds, [copy.floatingBlocks[0].id]);
  assert.deepEqual(copy.overflowGroups?.[0].fieldIds, [copy.overlayFields[0].id]);
  // The same person signs the copy; and the position is unchanged.
  assert.equal(copy.overlayFields[0].recipientId, "rcp-1");
  assert.deepEqual([copy.floatingBlocks[0].x, copy.floatingBlocks[0].y], [60, 600]);
  // The original is untouched, and the result is still a valid document.
  assert.deepEqual(doc.pages[1].overflowGroups?.[0].floatIds, ["float-1"]);
  assert.ok(documentSchema.safeParse(next).success);
});

test("pages move one place at a time and never off either end", () => {
  const doc = twoPages();
  const [a, b] = doc.pages.map((p) => p.id);
  assert.deepEqual(movePage(doc, b, -1).pages.map((p) => p.id), [b, a]);
  assert.deepEqual(movePage(doc, a, 1).pages.map((p) => p.id), [b, a]);
  assert.equal(movePage(doc, a, -1), doc, "the first page cannot move earlier");
  assert.equal(movePage(doc, b, 1), doc, "the last page cannot move later");
  assert.equal(movePage(doc, "no-such-page", 1), doc);
});

test("a page can be deleted, but never the last one", () => {
  const doc = twoPages();
  const next = removePage(doc, doc.pages[1].id);
  assert.deepEqual(next.pages.map((p) => p.id), [doc.pages[0].id]);
  assert.equal(removePage(next, next.pages[0].id), next, "a document always has a page");
  assert.equal(removePage(doc, "no-such-page"), doc);
});

test("an empty page is known to be empty, so deleting it asks nothing", () => {
  assert.equal(pageHasContent(newPage()), false);
  assert.equal(pageHasContent(twoPages().pages[1]), true);
  const onlyField = newPage();
  onlyField.overlayFields.push(newOverlayField("date"));
  assert.equal(pageHasContent(onlyField), true, "a page holding only a signing field is not empty");
});

test("the page controls and the working page are wired on the editor page", () => {
  const canvas = readFileSync("src/components/doceditor/Canvas.tsx", "utf8");
  assert.match(canvas, /onMouseDownCapture=\{\(\) => setActivePage\(pIdx\)\}/, "any click on a page makes it the working page");
  for (const call of ["movePage(page.id, -1)", "movePage(page.id, 1)", "duplicatePage(page.id)", "removePage(page.id)"]) assert.ok(canvas.includes(call), call);
  assert.match(canvas, /!pageHasContent\(page\) \|\| window\.confirm/, "a page with work on it is not deleted on one click");
  // A new signing field goes on the working page — it was always page 1.
  const palette = readFileSync("src/components/doceditor/Palette.tsx", "utf8");
  assert.doesNotMatch(palette, /addField\(0, field\)/);
  assert.match(palette, /addField\(Math\.min\(activePage,/);
});

test("the plain table is editable where it stands, and the panel no longer claims otherwise", () => {
  const view = readFileSync("src/components/doceditor/BlockView.tsx", "utf8");
  assert.match(view, /case "table":\s*return <TableView block=\{block\} \/>;/);
  assert.match(view, /onChange=\{\(e\) => setCell\(ri, ci, e\.target\.value\)\}/);
  assert.match(view, /onChange=\{\(e\) => setHeader\(ci, e\.target\.value\)\}/);
  const panel = readFileSync("src/components/doceditor/PropertiesPanel.tsx", "utf8");
  assert.doesNotMatch(panel, /Edit table cells inline on the page\./);
  assert.match(panel, /block\.type === "table" && <TableProps block=\{block\} \/>/);
});

test("a block's and a row's background are held to the colour rule", () => {
  const doc = blankDocument("Colours");
  const attack = `#fff" onmouseover="alert(1)" x="`;
  const raw = JSON.parse(JSON.stringify(doc));
  raw.pages[0].rows[0].settings.background = attack;
  raw.pages[0].rows[0].columns[0].blocks[0].settings.background = attack;
  const parsed = documentSchema.parse(raw);
  assert.equal(parsed.pages[0].rows[0].settings.background, undefined);
  assert.equal(parsed.pages[0].rows[0].columns[0].blocks[0].settings.background, undefined);
  raw.pages[0].rows[0].settings.background = "#0f172a";
  raw.pages[0].rows[0].columns[0].blocks[0].settings.background = "rgb(15, 23, 42)";
  const kept = documentSchema.parse(raw);
  assert.equal(kept.pages[0].rows[0].settings.background, "#0f172a");
  assert.equal(kept.pages[0].rows[0].columns[0].blocks[0].settings.background, "rgb(15, 23, 42)");
  // A document with neither set parses exactly as before.
  assert.ok(!("background" in documentSchema.parse(JSON.parse(JSON.stringify(doc))).pages[0].rows[0].settings) || documentSchema.parse(JSON.parse(JSON.stringify(doc))).pages[0].rows[0].settings.background === undefined);
});
