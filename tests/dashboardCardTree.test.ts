import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterCards,
  findCardInTree,
  isContainerCard,
  liftFromContainer,
  mapCards,
  reorderInTree,
} from "../src/lib/dashboard/cardTree";
import ContainerContents, {
  type ContainerActions,
} from "../src/components/dashboard/editor/ContainerContents";
import {
  MAX_CARD_DEPTH,
  type CardConfig,
  type DashboardConfig,
  type GridCardConfig,
} from "../src/lib/dashboard/config";

/**
 * REACHING CARDS THE DRAG CANNOT.
 *
 * A card inside a grid or stack is drawn by that container on the server, so the
 * editor has no sortable element for it: drag only ever reordered the TOP level.
 * A card placed inside a group had no way to be moved, reordered or taken back
 * out, and the only route to it was the raw JSON editor. That is what "these are
 * not individual widgets" was describing.
 *
 * TWO HALVES, AND ONLY ONE OF THEM WAS EVER TESTED. The helpers below have always
 * descended, so the DATA operation could always reach a card three levels down.
 * The editor could not: it listed a container's immediate children and stopped,
 * so grid A holding grid B holding card C left C unselectable — exactly the state
 * the feature existed to end — while a green helper test said the opposite. A
 * helper that can move a card nobody can point at is not a feature.
 *
 * So the UI half is executed here too, not matched from source. ContainerContents
 * is deliberately hook-free and takes its actions as props, which means this
 * process can render it without a DOM and drive its buttons; the recursion under
 * test is then the component's own, and a version that stopped at the first level
 * simply would not produce the rows.
 */

const card = (id: string): CardConfig =>
  ({ id, title: id, type: "markdown", span: 1, content: id }) as CardConfig;

const group = (id: string, cards: CardConfig[]): CardConfig =>
  ({ id, title: id, type: "grid", span: 3, columns: 2, cards }) as CardConfig;

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

/** Nested ids to whatever depth the tree goes, unlike idsOf which stops at one. */
const shape = (cards: CardConfig[]): unknown[] =>
  cards.map((c) => (isContainerCard(c) ? { [c.id]: shape(c.cards) } : c.id));

const treeOf = (config: DashboardConfig): unknown[] =>
  shape(config.views[0].sections[0].cards);

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

// ── changing and removing, at any depth ─────────────────────────────────────

test("an edit reaches a card inside a container", () => {
  // A hand-rolled walk that forgot to descend into grid/stack would make editing
  // a nested card silently do nothing: the dialog closes, the change is gone, and
  // nothing reports an error.
  const before = doc([group("outer", [group("inner", [card("p")])])]);
  const after = mapCards(before, (c) => (c.id === "p" ? { ...c, title: "renamed" } : c));
  assert.equal(findCardInTree(after, "p")?.title, "renamed");
  // And the branch above it is intact rather than rebuilt as a leaf.
  assert.deepEqual(treeOf(after), [{ outer: [{ inner: ["p"] }] }]);
});

test("a removal reaches a card inside a container", () => {
  const before = doc([group("outer", [group("inner", [card("p"), card("q")])])]);
  assert.deepEqual(treeOf(filterCards(before, (c) => c.id !== "p")), [
    { outer: [{ inner: ["q"] }] },
  ]);
});

test("the settings dialog can resolve a card at any depth", () => {
  // The dialog is handed an ID, not a card. A lookup that stopped one level short
  // would open empty on exactly the cards the editor now offers a button for.
  const config = doc([group("outer", [group("inner", [card("p")])])]);
  assert.equal(findCardInTree(config, "p")?.id, "p");
  assert.equal(findCardInTree(config, "nope"), null);
});

// ── the editor that reaches them ────────────────────────────────────────────

const NOTHING: ContainerActions = {
  onConfigure: () => {},
  onMove: () => {},
  onLift: () => {},
  onRemove: () => {},
};

type Element = { type: unknown; props: Record<string, unknown> };

/**
 * Every element the editor draws, with its components actually run.
 *
 * ContainerContents is hook-free by design, so calling it IS rendering it, and
 * the nested lists it returns get run in turn. That is the whole difference
 * between this and the source match it replaces: the recursion being exercised is
 * the component's own, so a version that listed `cards` and stopped would produce
 * no row for a grandchild and every assertion below would fail.
 */
function* rendered(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const child of node) yield* rendered(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  const element = node as Element;
  if (typeof element.type === "function") {
    yield* rendered((element.type as (props: unknown) => unknown)(element.props));
    return;
  }
  yield element;
  yield* rendered(element.props?.children);
}

/** Every control the editor offers, by its accessible name. */
function controls(node: unknown): Map<string, Element> {
  const found = new Map<string, Element>();
  for (const element of rendered(node)) {
    const label = element.props["aria-label"];
    if (typeof label === "string") found.set(label, element);
  }
  return found;
}

/** Press a button the way a user would — through its accessible name. */
function press(node: unknown, label: string): void {
  const button = controls(node).get(label);
  assert.ok(button, `the editor offers no control called "${label}"`);
  assert.notEqual(button.props.disabled, true, `"${label}" is disabled`);
  (button.props.onClick as () => void)();
}

/** The cards a container's own list offers a settings button for. */
function configurable(cards: CardConfig[]): string[] {
  const names: string[] = [];
  for (const label of controls(createElement(ContainerContents, { cards, actions: NOTHING })).keys()) {
    if (label.startsWith("Settings for ")) names.push(label.slice("Settings for ".length));
  }
  return names.sort();
}

test("the editor exposes controls for a grandchild, not only for immediate children", () => {
  /*
   * THE REGRESSION. Grid A holds grid B holds card C.
   *
   * The first version of this list rendered `card.cards` once and gave each
   * immediate child a row. B became selectable; C did not, and no route to it
   * existed outside the raw JSON editor — while the helper tests above passed,
   * because a helper being able to move C says nothing about whether anyone can
   * ask it to. The set below is the honest question: which cards does the editor
   * actually put controls on the screen for?
   */
  const inA = [group("B", [card("C")]), card("sibling")];
  assert.deepEqual(configurable(inA), ["B", "C", "sibling"]);
});

test("every action a child gets, a grandchild gets too", () => {
  // Half a row is worse than no row: a card you can see listed but cannot remove
  // reads as the editor being broken rather than as a feature that stops short.
  const offered = controls(
    createElement(ContainerContents, { cards: [group("B", [card("C")])], actions: NOTHING }),
  );
  for (const label of [
    "Settings for C",
    "Remove C",
    "Move C earlier",
    "Move C later",
    "Move C out of this group",
  ]) {
    assert.ok(offered.has(label), `a grandchild must be able to be: ${label}`);
  }
});

test("a grandchild can be configured, moved, lifted and removed", () => {
  /*
   * Driven end to end, against the REAL helpers rather than spies.
   *
   * A button that calls onMove with the right id and a helper that moves the
   * right card are each half of the feature, and the half that was missing was
   * the button — so a test that stopped at "the callback fired" would have passed
   * against the very code this replaces. Here the presses go through the same
   * functions the provider and the editor root call, and the assertions are about
   * the config that comes out.
   */
  let config = doc([group("A", [group("B", [card("C"), card("D")])])]);
  let opened: CardConfig | null = null;

  const actions: ContainerActions = {
    onConfigure: (id) => {
      opened = findCardInTree(config, id);
    },
    onMove: (id, direction) => {
      config = reorderInTree(config, id, direction);
    },
    onLift: (id) => {
      config = liftFromContainer(config, id);
    },
    onRemove: (id) => {
      config = filterCards(config, (c) => c.id !== id);
    },
  };

  // Re-read from the config each time: the editor re-renders from the document
  // after every change, and a stale element tree would hide a helper that moved
  // the wrong card.
  const editor = () => {
    const a = config.views[0].sections[0].cards[0] as GridCardConfig;
    return createElement(ContainerContents, { cards: a.cards, actions });
  };

  press(editor(), "Settings for C");
  assert.equal((opened as CardConfig | null)?.id, "C", "settings must open on C, not on its group");

  press(editor(), "Move C later");
  assert.deepEqual(treeOf(config), [{ A: [{ B: ["D", "C"] }] }], "it must move inside B");

  press(editor(), "Move C earlier");
  assert.deepEqual(treeOf(config), [{ A: [{ B: ["C", "D"] }] }]);

  press(editor(), "Move C out of this group");
  assert.deepEqual(
    treeOf(config),
    [{ A: [{ B: ["D"] }, "C"] }],
    "lifting must move it out one level, to just after B, not all the way to the section",
  );

  press(editor(), "Remove C");
  assert.deepEqual(treeOf(config), [{ A: [{ B: ["D"] }] }]);
});

test("a grandchild's move buttons are bounded by its own siblings", () => {
  // The disabled state has to come from the list the card is IN. Read off the
  // outer container instead, the first grandchild could be nudged off the front
  // of its group and the last one would be stuck one short of the end.
  const offered = controls(
    createElement(ContainerContents, {
      cards: [card("only"), group("B", [card("C"), card("D"), card("E")])],
      actions: NOTHING,
    }),
  );
  assert.equal(offered.get("Move C earlier")?.props.disabled, true, "C is first among C, D, E");
  assert.equal(offered.get("Move C later")?.props.disabled, false);
  assert.equal(offered.get("Move E earlier")?.props.disabled, false);
  assert.equal(offered.get("Move E later")?.props.disabled, true, "E is last among C, D, E");
});

test("the whole list renders to markup, so a grandchild is on the screen and not merely in the tree", () => {
  const markup = renderToStaticMarkup(
    createElement(ContainerContents, { cards: [group("B", [card("C")])], actions: NOTHING }),
  );
  assert.ok(markup.includes("Settings for C"), "C must be drawn, not just constructed");
});

test("the list is bounded, so a container holding itself cannot run away", () => {
  /*
   * A cycle cannot come from the parser — a config arrives as JSON — and
   * cardSchema stops offering container types past MAX_CARD_DEPTH, so anything
   * deeper fails to parse and is dropped. The bound is what makes those the
   * caller's promises rather than this component's problem: without it, how deep
   * the recursion goes is decided by the data.
   *
   * The DEPTH is asserted rather than "it returned", and that distinction is the
   * whole test. React's server renderer happens to unwind a runaway tree instead
   * of hanging, so an unbounded version also returns — it just draws sixty-odd
   * rows for the same card. Only counting them tells the two apart.
   */
  const loop = group("loop", []) as GridCardConfig;
  loop.cards.push(loop);
  const markup = renderToStaticMarkup(
    createElement(ContainerContents, { cards: [loop], actions: NOTHING }),
  );
  assert.equal(
    markup.split("Settings for loop").length - 1,
    MAX_CARD_DEPTH,
    "the list must stop at the nesting the schema allows",
  );
});
