import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dropPreview, layoutWithMarker, moveCardInView } from "../src/lib/dashboard/canvasMove";
import type { CardConfig, SectionConfig, ViewConfig } from "../src/lib/dashboard/config";

/**
 * Source with CRLF normalised.
 *
 * This repo stores CRLF, so an anchor written with a bare newline silently never
 * matches — which reads as a missing guard rather than a broken test.
 */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

/** …and with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CANVAS = "src/components/dashboard/editor/DashboardCanvas.tsx";

/*
 * THE DOCUMENT DOES NOT CHANGE DURING A DRAG.
 *
 * It used to: the real move was applied on every dragover, so the arrangement
 * reflowed live under the pointer. Two cards can swap forever that way — drag A
 * over B and A takes B's index, so the pointer, which has not moved, is over B
 * again, and the next dragover moves A back.
 *
 * The captured browser stack is the evidence, not the theory:
 *
 *     at useDroppableMeasuring.useCallback[measureDroppableContainers]
 *     at SortableContext.useIsomorphicLayoutEffect
 *     at commitHookLayoutEffects
 *
 * dnd-kit only calls measureDroppableContainers when its item list has changed
 * IN VALUE, from a layout effect. It was doing so often enough in one commit to
 * pass React's nested-update limit — "Maximum update depth exceeded", thrown
 * during commit, caught by the route's error boundary as an error page. Every
 * one of those calls means the order changed again.
 *
 * So a drag now moves a marker, and the document changes once, on the drop.
 */

/* ── fixtures ─────────────────────────────────────────────────────── */

const card = (id: string): CardConfig => ({ id, type: "heading", span: 1, text: id }) as CardConfig;

const section = (id: string, ids: string[]): SectionConfig => ({
  id,
  columnSpan: 1,
  cards: ids.map(card),
});

const view = (sections: SectionConfig[]): ViewConfig => ({
  id: "view-1",
  title: "Overview",
  path: "overview",
  columns: 3,
  sections,
});

/* ── the invariant ────────────────────────────────────────────────── */

/**
 * The marker promises a position. This checks the drop keeps it.
 *
 * Where the marker is drawn and where `moveCardInView` puts the card are two
 * separate calculations over the same gesture, and a marker that promises one
 * position while the drop delivers another is worse than no marker at all — it
 * is the same "it went somewhere I did not aim" complaint, with a confident
 * label on it.
 */
function assertMarkerKeepsItsPromise(before: ViewConfig, activeId: string, overId: string) {
  const preview = dropPreview(before, activeId, overId);
  assert.ok(preview, `expected a preview for ${activeId} over ${overId}`);

  const after = moveCardInView(before, activeId, overId);
  const landed = after.sections.find((s) => s.id === preview.sectionId);
  assert.ok(landed, "the previewed section must exist after the move");

  const actual = landed.cards.findIndex((c) => c.id === activeId);
  assert.equal(
    actual,
    preview.index,
    `marker promised index ${preview.index} in ${preview.sectionId}, card landed at ${actual}`,
  );
}

test("within a section, forwards", () => {
  // The off-by-one case. Counting the target among the cards WITHOUT the dragged
  // one gives 1 here; the card actually lands at 2, because the move lifts it out
  // and re-inserts at the index the target had before the lift.
  const before = view([section("s1", ["a", "b", "c"])]);
  assertMarkerKeepsItsPromise(before, "a", "c");
  assert.deepEqual(dropPreview(before, "a", "c"), { sectionId: "s1", index: 2 });
});

test("within a section, backwards", () => {
  const before = view([section("s1", ["a", "b", "c"])]);
  assertMarkerKeepsItsPromise(before, "c", "a");
  assert.deepEqual(dropPreview(before, "c", "a"), { sectionId: "s1", index: 0 });
});

test("within a section, onto the neighbour", () => {
  const before = view([section("s1", ["a", "b"])]);
  assertMarkerKeepsItsPromise(before, "a", "b");
  assertMarkerKeepsItsPromise(before, "b", "a");
});

test("into the empty space below its own section", () => {
  const before = view([section("s1", ["a", "b", "c"])]);
  assertMarkerKeepsItsPromise(before, "a", "s1");
  assert.deepEqual(dropPreview(before, "a", "s1"), { sectionId: "s1", index: 2 });
});

test("into another section, onto a card", () => {
  const before = view([section("s1", ["a"]), section("s2", ["x", "y"])]);
  assertMarkerKeepsItsPromise(before, "a", "x");
  assertMarkerKeepsItsPromise(before, "a", "y");
  assert.deepEqual(dropPreview(before, "a", "y"), { sectionId: "s2", index: 1 });
});

test("into another section's empty space", () => {
  const before = view([section("s1", ["a"]), section("s2", ["x", "y"])]);
  assertMarkerKeepsItsPromise(before, "a", "s2");
  assert.deepEqual(dropPreview(before, "a", "s2"), { sectionId: "s2", index: 2 });
});

test("into an emptied section", () => {
  const before = view([section("s1", ["a"]), section("s2", [])]);
  assertMarkerKeepsItsPromise(before, "a", "s2");
  assert.deepEqual(dropPreview(before, "a", "s2"), { sectionId: "s2", index: 0 });
});

test("every card over every target keeps the promise", () => {
  // The invariant, swept rather than sampled — two sections, five cards, and the
  // sections themselves as targets.
  const before = view([section("s1", ["a", "b", "c"]), section("s2", ["x", "y"])]);
  const cards = ["a", "b", "c", "x", "y"];
  const targets = [...cards, "s1", "s2"];
  let checked = 0;
  for (const active of cards) {
    for (const over of targets) {
      if (active === over) continue;
      if (!dropPreview(before, active, over)) continue;
      assertMarkerKeepsItsPromise(before, active, over);
      checked += 1;
    }
  }
  assert.ok(checked >= 25, `expected a real sweep, only checked ${checked}`);
});

/* ── nothing to preview ───────────────────────────────────────────── */

test("an unknown card or target has no preview, and does not throw", () => {
  const before = view([section("s1", ["a"])]);
  assert.equal(dropPreview(before, "ghost", "a"), null);
  assert.equal(dropPreview(before, "a", "ghost"), null);
});

/* ── the wiring ───────────────────────────────────────────────────── */

test("dragging over something does not change the document", () => {
  const canvas = code(CANVAS);
  const handler = canvas.slice(canvas.indexOf("function onDragOver"));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.doesNotMatch(
    body,
    /update(View|Section|Card)?\(/,
    "a drag must not edit the config until it is dropped",
  );
  assert.match(body, /dropPreview\(view, activeCardId, overId\)/);
});

test("the drop is what commits the move, once", () => {
  const canvas = code(CANVAS);
  const handler = canvas.slice(canvas.indexOf("function onDragEnd"));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.match(body, /moveCardInView\(current, activeCardId, overId\)/);
  assert.match(canvas, /onDragEnd=\{onDragEnd\}/);
});

test("a drop outside every droppable still goes where the marker promised", () => {
  // dnd-kit reports `over` as null when the pointer leaves every droppable on
  // release. Treating that as "no move" would silently discard the gesture the
  // user just watched being previewed.
  const canvas = code(CANVAS);
  assert.match(canvas, /const overId = event\.over \? String\(event\.over\.id\) : lastOverId\.current;/);
});

test("the marker is drawn, and the dragged card is not the marker", () => {
  // The dragged card stays where it is, dimmed. It is the SOURCE; the marker is
  // the destination, and labelling both "Drops here" would be a lie on one.
  const canvas = read(CANVAS);
  assert.match(canvas, /function DropMarker\(\)/);
  assert.match(canvas, /Drops here/);
  assert.equal(
    (canvas.match(/Drops here/g) ?? []).length,
    1,
    "only the marker may claim to be the destination",
  );
});

test("the dragged card is skipped when counting to the marker's slot", () => {
  // `dropAt` counts the cards WITHOUT the dragged one. Counting it would put the
  // marker one place out for every move within a section.
  // Checked by running `layoutWithMarker` above, not by matching these lines —
  // the source-matching version of this test passed unchanged when the insert
  // was moved to after the slot instead of before it. All this checks is that
  // the canvas still delegates rather than growing its own copy.
  const canvas = code(CANVAS);
  assert.match(canvas, /layoutWithMarker\(/, "the canvas must use the tested placement");
  assert.doesNotMatch(canvas, /let slot = 0/, "and must not re-implement the counting");
});

/* ── where the marker is drawn ────────────────────────────────────── */

/**
 * The marker's DRAWN position, checked against the final order.
 *
 * The previous test group proves the previewed index matches where the card
 * lands. This proves the marker is drawn at that index — a separate off-by-one,
 * because the dragged card is still on screen while not being counted, and
 * getting that wrong puts the marker one place out for every move.
 *
 * Asserted by running the placement rather than grepping for it: an earlier
 * version of this test matched the line that inserts the marker, and passed
 * unchanged when the insert was moved to AFTER the slot instead of before it.
 */
function markerIndex(slots: ReturnType<typeof layoutWithMarker>): number {
  return slots.findIndex((entry) => entry.kind === "marker");
}

/** The drawn order with the marker and the dragged card taken out. */
function othersInOrder(slots: ReturnType<typeof layoutWithMarker>, activeId: string): string[] {
  return slots
    .filter((entry) => entry.kind === "card" && entry.id !== activeId)
    .map((entry) => (entry as { kind: "card"; id: string }).id);
}

test("the marker is drawn where the card will end up", () => {
  const before = view([section("s1", ["a", "b", "c"]), section("s2", ["x", "y"])]);
  const cards = ["a", "b", "c", "x", "y"];
  const targets = [...cards, "s1", "s2"];

  for (const active of cards) {
    for (const over of targets) {
      if (active === over) continue;
      const preview = dropPreview(before, active, over);
      if (!preview) continue;

      const target = before.sections.find((s) => s.id === preview.sectionId)!;
      const drawn = layoutWithMarker(
        target.cards.map((c) => c.id),
        active,
        preview.index,
      );

      // The marker must be present, and sit at `index` counting only the other
      // cards — which is exactly the position the card occupies afterwards.
      const at = markerIndex(drawn);
      assert.ok(at >= 0, `no marker drawn for ${active} over ${over}`);
      const others = othersInOrder(drawn, active);
      const beforeMarker = drawn
        .slice(0, at)
        .filter((e) => e.kind === "card" && e.id !== active).length;
      assert.equal(
        beforeMarker,
        preview.index,
        `${active} over ${over}: marker drawn after ${beforeMarker} cards, promised ${preview.index}`,
      );

      // And the surviving order is untouched — the drag must not reflow anything.
      assert.deepEqual(
        others,
        target.cards.filter((c) => c.id !== active).map((c) => c.id),
        "drawing the marker must not reorder the cards",
      );
    }
  }
});

test("the dragged card stays on screen, in its own place", () => {
  // Removing it mid-gesture would reflow the grid, which is the thing this design
  // exists to stop.
  const drawn = layoutWithMarker(["a", "b", "c"], "a", 2);
  assert.deepEqual(
    drawn.filter((e) => e.kind === "card").map((e) => (e as { id: string }).id),
    ["a", "b", "c"],
  );
});

test("the marker goes BEFORE the card holding its slot, not after", () => {
  // The mutation that survived a source-matching version of this test: moving the
  // insert to after the increment draws the marker one place late.
  assert.deepEqual(layoutWithMarker(["a", "b"], null, 0), [
    { kind: "marker" },
    { kind: "card", id: "a" },
    { kind: "card", id: "b" },
  ]);
  assert.deepEqual(layoutWithMarker(["a", "b"], null, 1), [
    { kind: "card", id: "a" },
    { kind: "marker" },
    { kind: "card", id: "b" },
  ]);
});

test("a marker past the last slot lands at the end", () => {
  assert.deepEqual(layoutWithMarker(["a", "b"], null, 2), [
    { kind: "card", id: "a" },
    { kind: "card", id: "b" },
    { kind: "marker" },
  ]);
  // And an out-of-range index does not silently vanish the marker.
  assert.equal(markerIndex(layoutWithMarker(["a", "b"], null, 9)), 2);
});

test("no marker when nothing is being dragged", () => {
  assert.deepEqual(layoutWithMarker(["a", "b"], null, null), [
    { kind: "card", id: "a" },
    { kind: "card", id: "b" },
  ]);
  assert.deepEqual(layoutWithMarker([], null, null), []);
});

test("an empty section still draws the marker", () => {
  // Otherwise dropping into a group you have just emptied shows nothing at all.
  assert.deepEqual(layoutWithMarker([], "a", 0), [{ kind: "marker" }]);
});
