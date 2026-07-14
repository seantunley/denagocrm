import test from "node:test";
import assert from "node:assert/strict";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { insertRelative, findBlockLoc, deleteBlock, setColumnWidths, duplicateBlock, detachBlock, dockFloating, isFloating, removeAnyBlock, getBlock } from "../src/lib/doceditor/ops";

function textId(doc: ReturnType<typeof blankDocument>) {
  return doc.pages[0].rows[0].columns[0].blocks.find((b) => b.type === "text")!.id;
}

test("blank document has one A4 page with a heading + text", () => {
  const doc = blankDocument();
  assert.equal(doc.pages.length, 1);
  const col = doc.pages[0].rows[0].columns[0];
  assert.equal(col.blocks.length, 2);
  assert.equal(col.widthPercent, 100);
});

test("drop RIGHT of a block splits its row into two columns (50/50)", () => {
  const doc = blankDocument();
  const target = textId(doc);
  const img = newBlock("image");
  const next = insertRelative(doc, target, "right", img);
  const row = next.pages[0].rows[0];
  assert.equal(row.columns.length, 2);
  assert.equal(row.columns[0].widthPercent, 50);
  assert.equal(row.columns[1].widthPercent, 50);
  // image is in the right column
  assert.equal(row.columns[1].blocks[0].type, "image");
});

test("drop BELOW inserts a new row after the target's row", () => {
  const doc = blankDocument();
  const before = doc.pages[0].rows.length;
  const next = insertRelative(doc, textId(doc), "below", newBlock("text"));
  assert.equal(next.pages[0].rows.length, before + 1);
});

test("drop ABOVE inserts a new row before the target's row", () => {
  const doc = blankDocument();
  const next = insertRelative(doc, textId(doc), "above", newBlock("divider"));
  assert.equal(next.pages[0].rows[0].columns[0].blocks[0].type, "divider");
});

test("moving an existing block does not duplicate it", () => {
  const doc = blankDocument();
  // add a third block via BELOW, then move it beside the text
  const withImg = insertRelative(doc, textId(doc), "below", newBlock("image"));
  const imgId = withImg.pages[0].rows[1].columns[0].blocks[0].id;
  const moved = insertRelative(withImg, textId(withImg), "right", newBlock("image"), imgId);
  // the source row (empty after move) is pruned; total image blocks stays 1
  let images = 0;
  for (const p of moved.pages) for (const r of p.rows) for (const c of r.columns) for (const b of c.blocks) if (b.type === "image") images++;
  assert.equal(images, 1);
});

test("setColumnWidths normalises to 100", () => {
  const doc = blankDocument();
  const split = insertRelative(doc, textId(doc), "right", newBlock("image"));
  const rowId = split.pages[0].rows[0].id;
  const sized = setColumnWidths(split, rowId, [70, 30]);
  const row = sized.pages[0].rows[0];
  assert.equal(row.columns[0].widthPercent, 70);
  assert.equal(row.columns[1].widthPercent, 30);
});

test("delete then prune removes empty rows/columns", () => {
  const doc = blankDocument();
  const split = insertRelative(doc, textId(doc), "right", newBlock("image"));
  const imgId = split.pages[0].rows[0].columns[1].blocks[0].id;
  const afterDel = deleteBlock(split, imgId);
  const row = afterDel.pages[0].rows[0];
  assert.equal(row.columns.length, 1); // back to a single full-width column
  assert.equal(row.columns[0].widthPercent, 100);
});

test("detach lifts a flow block into the page's floating layer", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const detached = detachBlock(doc, tid);
  assert.equal(isFloating(detached, tid), true);
  assert.equal(detached.pages[0].floatingBlocks.length, 1);
  // removed from the flow
  assert.equal(findBlockLoc(detached, tid), null);
  // still editable via getBlock
  assert.ok(getBlock(detached, tid));
});

test("dock returns a floating block into the flow", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const detached = detachBlock(doc, tid);
  const docked = dockFloating(detached, tid);
  assert.equal(isFloating(docked, tid), false);
  assert.equal(docked.pages[0].floatingBlocks.length, 0);
  assert.ok(findBlockLoc(docked, tid)); // back in a column
});

test("removeAnyBlock deletes floating blocks too", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const detached = detachBlock(doc, tid);
  const removed = removeAnyBlock(detached, tid);
  assert.equal(removed.pages[0].floatingBlocks.length, 0);
  assert.equal(getBlock(removed, tid), null);
});

test("duplicate inserts a copy with a new id right after", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const dup = duplicateBlock(doc, tid);
  const loc = findBlockLoc(dup, tid)!;
  const col = dup.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx];
  assert.equal(col.blocks.filter((b) => b.type === "text").length, 2);
  const ids = col.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length); // all ids unique
});
