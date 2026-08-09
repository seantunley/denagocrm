import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { liftFromContainer, reorderInTree } from "../src/lib/dashboard/cardTree";
import type { CardConfig, DashboardConfig } from "../src/lib/dashboard/config";

/**
 * MOVING CARDS THE DRAG CANNOT REACH.
 *
 * A card inside a grid or stack is drawn by that container on the server, so the
 * editor has no sortable element for it: drag only ever reordered the TOP level.
 * A card placed inside a group had no way to be moved, reordered or taken back
 * out, and the only route to it was the raw JSON editor. That is what "these are
 * not individual widgets" was describing.
 *
 * These are executed rather than asserted from source, deliberately. A tree walk
 * that silently fails to descend is the exact bug worth running.
 */

const card = (id: string): CardConfig =>
  ({ id, type: "markdown", span: 1, content: id }) as CardConfig;

const group = (id: string, cards: CardConfig[]): CardConfig =>
  ({ id, type: "grid", span: 3, columns: 2, cards }) as CardConfig;

const doc = (cards: CardConfig[]): DashboardConfig =>
  ({
    views: [
      { id: "v", path: "m", title: "M", columns: 3, sections: [{ id: "s", columnSpan: 3, cards }] },
    ],
  }) as DashboardConfig;

const idsOf = (config: DashboardConfig): unknown =>
  config.views[0].sections[0].cards.map((c) =>
    c.type === "grid" || c.type === "stack" ? { [c.id]: c.cards.map((k) => k.id) } : c.id,
  );

// ── reordering ──────────────────────────────────────────────────────────────

test("a top-level card moves among its siblings", () => {
  const before = doc([card("a"), card("b"), card("c")]);
  assert.deepEqual(idsOf(reorderInTree(before, "b", -1)), ["b", "a", "c"]);
  assert.deepEqual(idsOf(reorderInTree(before, "b", 1)), ["a", "c", "b"]);
});

test("a card INSIDE a group moves among its siblings", () => {
  // The case drag could never do.
  const before = doc([group("g", [card("x"), card("y"), card("z")])]);
  assert.deepEqual(idsOf(reorderInTree(before, "y", -1)), [{ g: ["y", "x", "z"] }]);
  assert.deepEqual(idsOf(reorderInTree(before, "y", 1)), [{ g: ["x", "z", "y"] }]);
});

test("a card at either end does not move, and does not escape its group", () => {
  // A nudge that hopped into a neighbouring container would be a surprising
  // thing for an arrow button to do.
  const before = doc([group("g", [card("x"), card("y")]), card("after")]);
  assert.deepEqual(idsOf(reorderInTree(before, "x", -1)), [{ g: ["x", "y"] }, "after"]);
  assert.deepEqual(idsOf(reorderInTree(before, "y", 1)), [{ g: ["x", "y"] }, "after"]);
});

test("reordering reaches a card nested two levels down", () => {
  const before = doc([group("outer", [group("inner", [card("p"), card("q")])])]);
  const after = reorderInTree(before, "q", -1);
  const outer = after.views[0].sections[0].cards[0] as Extract<CardConfig, { type: "grid" }>;
  const inner = outer.cards[0] as Extract<CardConfig, { type: "grid" }>;
  assert.deepEqual(
    inner.cards.map((c) => c.id),
    ["q", "p"],
  );
});

test("an unknown id changes nothing", () => {
  const before = doc([group("g", [card("x")]), card("a")]);
  assert.deepEqual(idsOf(reorderInTree(before, "nope", 1)), idsOf(before));
});

// ── lifting out ─────────────────────────────────────────────────────────────

test("a card lifts out of its group and lands just after it", () => {
  // After, not at the end: the card was visually inside the group, so the
  // nearest position that is still "about here" is immediately past it.
  const before = doc([card("first"), group("g", [card("x"), card("y")]), card("last")]);
  assert.deepEqual(idsOf(liftFromContainer(before, "x")), [
    "first",
    { g: ["y"] },
    "x",
    "last",
  ]);
});

test("lifting the last child leaves an empty group, not a missing one", () => {
  // Removing the group as well would delete something the user did not ask to
  // delete — and an empty group is visible and removable on its own.
  const before = doc([group("g", [card("only")])]);
  assert.deepEqual(idsOf(liftFromContainer(before, "only")), [{ g: [] }, "only"]);
});

test("lifting from a nested group moves out one level, not all the way", () => {
  // One step at a time is predictable; jumping to the section would be a
  // different operation wearing the same button.
  const before = doc([group("outer", [group("inner", [card("p")])])]);
  const after = liftFromContainer(before, "p");
  const outer = after.views[0].sections[0].cards[0] as Extract<CardConfig, { type: "grid" }>;
  assert.deepEqual(
    outer.cards.map((c) => c.id),
    ["inner", "p"],
    "it should now sit beside the inner group, still inside the outer one",
  );
});

test("lifting a top-level card changes nothing", () => {
  const before = doc([card("a"), card("b")]);
  assert.deepEqual(idsOf(liftFromContainer(before, "a")), ["a", "b"]);
});

test("neither operation mutates the config it was given", () => {
  // The editor compares configs by value to decide whether to save; mutating in
  // place would make a change invisible to that comparison.
  const before = doc([group("g", [card("x"), card("y")])]);
  const snapshot = JSON.stringify(before);
  reorderInTree(before, "y", -1);
  liftFromContainer(before, "x");
  assert.equal(JSON.stringify(before), snapshot);
});

// ── the UI that reaches them ────────────────────────────────────────────────

test("a container lists its children so each one can be worked with", () => {
  // Source contract: the canvas is a client component and cannot be executed
  // here. What matters is that every child gets the actions its parent has.
  const canvas = readFileSync(
    join(process.cwd(), "src/components/dashboard/editor/DashboardCanvas.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(canvas, /function ContainerContents/);
  // Only for containers — a leaf card has no children to list.
  assert.match(canvas, /card\.type === "grid" \|\| card\.type === "stack"/);

  const strip = canvas.slice(canvas.indexOf("function ContainerContents"));
  for (const [action, pattern] of [
    ["settings", /onConfigure\(child\.id\)/],
    ["remove", /removeCard\(child\.id\)/],
    ["move earlier", /moveCard\(child\.id, -1\)/],
    ["move later", /moveCard\(child\.id, 1\)/],
    ["lift out", /liftCard\(child\.id\)/],
  ] as const) {
    assert.match(strip, pattern, `a child must be able to be ${action}`);
  }

  // The ends must not offer a move that does nothing.
  assert.match(strip, /disabled=\{index === 0\}/);
  assert.match(strip, /disabled=\{index === card\.cards\.length - 1\}/);
});
