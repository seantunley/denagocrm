import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { alignRects, distributeRects, groupMembers, matchWidths, movePlaced, nudgePlaced, pageBox, placedRects, removePlaced, setGroup } from "../src/lib/doceditor/arrange";
import { blankDocument, newBlock, newOverlayField, newPage } from "../src/lib/doceditor/factory";
import { documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";
import { acceptanceFieldRects } from "../src/lib/doceditor/showcaseRender";
import { useEditor } from "../src/lib/doceditor/store";

/** Arranging several placed things — freely placed blocks and signing fields — at once. */

const float = (id: string, x: number, y: number, width = 100, type: DocumentBlock["type"] = "text") =>
  ({ id: `fb-${id}`, x, y, width, block: { ...newBlock(type), id } as DocumentBlock });
const field = (id: string, x: number, y: number, width = 100, height = 40) =>
  newOverlayField("signature", { id, anchor: { mode: "page", blockId: null, x, y }, width, height });

function sample(): DocumentModel {
  const doc = blankDocument("Arrange");
  doc.pages[0].floatingBlocks = [float("a", 100, 100, 120), float("b", 300, 160, 80)];
  doc.pages[0].overlayFields = [field("s", 500, 400, 200, 50), field("d", 520, 500, 100, 30)];
  return doc;
}
const where = (doc: DocumentModel, id: string) => placedRects(doc.pages[0], [id])[id];

test("lining things up uses the box round them all; one thing lines up with the page", () => {
  const rects = { a: { x: 100, y: 100, w: 120, h: 40 }, b: { x: 300, y: 160, w: 80, h: 20 }, c: { x: 200, y: 300, w: 50, h: 60 } };
  assert.deepEqual(alignRects(rects, "left"), { a: { x: 100, y: 100 }, b: { x: 100, y: 160 }, c: { x: 100, y: 300 } });
  assert.deepEqual(alignRects(rects, "right").b, { x: 300, y: 160 });
  assert.deepEqual(alignRects(rects, "right").a, { x: 260, y: 100 });
  assert.deepEqual(alignRects(rects, "centre").c, { x: 215, y: 300 });
  assert.deepEqual(alignRects(rects, "bottom").a, { x: 100, y: 320 });
  assert.deepEqual(alignRects(rects, "middle").b, { x: 300, y: 220 });
  // One thing has nothing to line up with but the page.
  const page = pageBox(blankDocument("x"));
  assert.deepEqual(alignRects({ a: rects.a }, "centre", page), { a: { x: page.x + (page.w - 120) / 2, y: 100 } });
  assert.deepEqual(alignRects({ a: rects.a }, "left"), { a: { x: 100, y: 100 } }, "with no page given, it stays");
});

test("spacing evenly keeps the outer two and equalises the gaps", () => {
  const rects = { a: { x: 0, y: 0, w: 100, h: 10 }, b: { x: 130, y: 50, w: 50, h: 10 }, c: { x: 400, y: 90, w: 100, h: 10 } };
  const across = distributeRects(rects, "across");
  assert.deepEqual(across, { a: { x: 0, y: 0 }, b: { x: 225, y: 50 }, c: { x: 400, y: 90 } });
  assert.equal(across.b.x - (0 + 100), 400 - (across.b.x + 50), "equal gaps either side");
  assert.deepEqual(distributeRects(rects, "down").b, { x: 130, y: 45 });
  assert.deepEqual(distributeRects({ a: rects.a, b: rects.b }, "across"), {}, "two things have one gap — nothing to even out");
});

test("moving and nudging: blocks and fields alike, never off the top or left", () => {
  const doc = sample();
  const next = movePlaced(doc, { a: { x: 10, y: 20 }, s: { x: -50, y: 700 } });
  assert.deepEqual([where(next, "a").x, where(next, "a").y], [10, 20]);
  assert.deepEqual([where(next, "s").x, where(next, "s").y], [0, 700]);
  assert.equal(where(next, "b").x, 300, "what was not named stays");
  const nudged = nudgePlaced(doc, ["a", "b", "d"], 10, -5);
  assert.deepEqual([where(nudged, "a").x, where(nudged, "b").y, where(nudged, "d").x, where(nudged, "d").y], [110, 155, 530, 495]);
  assert.equal(nudgePlaced(doc, ["a"], 0, 0), doc);
  assert.equal(where(doc, "a").x, 100, "the original is untouched");
});

test("an acceptance card still carries the fields on its lines — once, even when they are selected with it", () => {
  const doc = blankDocument("Card");
  const card = float("card", 100, 600, 320, "acceptance");
  doc.pages[0].floatingBlocks = [card];
  // A signature and a date sitting exactly on the card's lines.
  const slots = acceptanceFieldRects(card);
  const sig = newOverlayField("signature", { id: "sig", anchor: { mode: "page", blockId: null, x: slots.signature.x, y: slots.signature.y }, width: slots.signature.width, height: slots.signature.height });
  const date = newOverlayField("date", { id: "date", anchor: { mode: "page", blockId: null, x: slots.date.x, y: slots.date.y }, width: slots.date.width, height: slots.date.height });
  doc.pages[0].overlayFields = [sig, date];
  const alone = nudgePlaced(doc, ["card"], 30, 40);
  assert.deepEqual([where(alone, sig.id).x, where(alone, sig.id).y], [sig.anchor.x + 30, sig.anchor.y + 40], "carried with the card");
  const together = nudgePlaced(doc, ["card", ...doc.pages[0].overlayFields.map((f) => f.id)], 30, 40);
  assert.deepEqual([where(together, sig.id).x, where(together, sig.id).y], [sig.anchor.x + 30, sig.anchor.y + 40], "not moved twice");
});

test("same width, grouping and deleting several", () => {
  const doc = sample();
  const same = matchWidths(doc, ["a", "b", "d"]);
  assert.deepEqual([where(same, "a").w, where(same, "b").w, where(same, "d").w, where(same, "s").w], [120, 120, 120, 200]);

  const grouped = setGroup(doc, ["a", "s"], "g1");
  assert.deepEqual(groupMembers(grouped, "a"), ["a", "s"]);
  assert.deepEqual(groupMembers(grouped, "s"), ["a", "s"]);
  assert.deepEqual(groupMembers(grouped, "b"), ["b"]);
  assert.equal(setGroup(doc, ["a"], "g2"), doc, "a group of one is no group");
  assert.ok(documentSchema.safeParse(grouped).success, "a grouped document is a valid document");
  const ungrouped = setGroup(grouped, ["a", "s"], null);
  assert.deepEqual(groupMembers(ungrouped, "a"), ["a"]);
  assert.equal("groupId" in ungrouped.pages[0].floatingBlocks[0], false, "no empty setting is left behind");
  // A group is its page's: the same id on another page is another group.
  const twoPages = { ...grouped, pages: [...grouped.pages, { ...newPage(), floatingBlocks: [{ ...float("z", 1, 1), groupId: "g1" }] }] };
  assert.deepEqual(groupMembers(twoPages, "a"), ["a", "s"]);

  const removed = removePlaced(doc, ["a", "d"]);
  assert.deepEqual([removed.pages[0].floatingBlocks.map((f) => f.block.id), removed.pages[0].overlayFields.map((f) => f.id)], [["b"], ["s"]]);
});

test("the editor's selection: shift-click builds it, a group is selected as one, and a drag takes the rest along", () => {
  const editor = () => useEditor.getState();
  editor().load(sample());
  editor().select("a");
  assert.deepEqual(editor().picked, [], "one thing selected is not a multi-selection");
  editor().togglePick("s");
  assert.deepEqual(editor().picked, ["a", "s"]);
  assert.deepEqual(editor().sel, { blockId: null, fieldId: "s" }, "the last one clicked is the primary");
  editor().togglePick("b");
  editor().togglePick("s");
  assert.deepEqual(editor().picked, ["a", "b"]);
  // Clicking a member keeps the selection, so it can be dragged; the rest follow by the same distance — one undo step.
  editor().select("a");
  assert.deepEqual(editor().picked, ["a", "b"]);
  editor().dragPlacedTo("a", { x: 150, y: 90 });
  assert.deepEqual([where(editor().doc, "a").x, where(editor().doc, "a").y, where(editor().doc, "b").x, where(editor().doc, "b").y], [150, 90, 350, 150]);
  editor().undo();
  assert.deepEqual([where(editor().doc, "a").x, where(editor().doc, "b").x], [100, 300]);
  // Clicking something outside it starts again; taking one of two out leaves no multi-selection.
  editor().selectField("d");
  assert.deepEqual(editor().picked, []);
  editor().togglePick("s");
  editor().togglePick("s");
  assert.deepEqual(editor().picked, []);

  editor().load(setGroup(sample(), ["b", "d"], "g1"));
  editor().selectField("d");
  assert.deepEqual(editor().picked, ["b", "d"], "clicking one member of a group selects the group");
  editor().removePicked();
  assert.deepEqual([editor().doc.pages[0].floatingBlocks.length, editor().doc.pages[0].overlayFields.length, editor().picked.length], [1, 1, 0]);
});

test("the layers and the keyboard are wired to it", () => {
  const read = (file: string) => readFileSync(`src/components/doceditor/${file}`, "utf8");
  for (const layer of ["FloatingLayer.tsx", "OverlayLayer.tsx"]) {
    assert.match(read(layer), /if \(e\.shiftKey\) togglePick\(/, `${layer}: shift-click adds to the selection`);
    assert.match(read(layer), /dragPlacedTo\(/, `${layer}: a drag takes the selection along`);
  }
  const editor = read("DocEditor.tsx");
  assert.match(editor, /nudgePlaced\(d, ids, /);
  assert.match(editor, /if \(picked\.length\) \{\s*event\.preventDefault\(\);\s*removePicked\(\);/);
  assert.match(read("PropertiesPanel.tsx"), /picked\.length >= 2 \? <ArrangePanel ids=\{picked\} \/>/);
});
