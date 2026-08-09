import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { moveCardInView } from "../src/lib/dashboard/canvasMove";
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

const PROVIDER = "src/components/dashboard/editor/EditorProvider.tsx";
const CANVAS = "src/components/dashboard/editor/DashboardCanvas.tsx";

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

/** The card ids of a section, for readable assertions. */
const idsIn = (v: ViewConfig, sectionId: string) =>
  v.sections.find((s) => s.id === sectionId)!.cards.map((c) => c.id);

/* ── within one group ─────────────────────────────────────────────── */

test("a card takes the place of the card it is over", () => {
  const before = view([section("s1", ["a", "b", "c"])]);
  assert.deepEqual(idsIn(moveCardInView(before, "c", "a"), "s1"), ["c", "a", "b"]);
  assert.deepEqual(idsIn(moveCardInView(before, "a", "c"), "s1"), ["b", "c", "a"]);
});

test("dropping in the empty space below its own group sends it to the end", () => {
  // This did nothing at all before: the target index resolved to -1 and the move
  // was silently discarded, so a card could never be dragged to the bottom of
  // the group it was already in.
  const before = view([section("s1", ["a", "b", "c"])]);
  assert.deepEqual(idsIn(moveCardInView(before, "a", "s1"), "s1"), ["b", "c", "a"]);
});

test("the last card dropped below itself does not move", () => {
  const before = view([section("s1", ["a", "b", "c"])]);
  assert.equal(moveCardInView(before, "c", "s1"), before, "must be a no-op, by reference");
});

/* ── between groups ───────────────────────────────────────────────── */

test("a card moved to another group leaves the first one", () => {
  const before = view([section("s1", ["a", "b"]), section("s2", ["x", "y"])]);
  const after = moveCardInView(before, "a", "y");
  assert.deepEqual(idsIn(after, "s1"), ["b"]);
  assert.deepEqual(idsIn(after, "s2"), ["x", "a", "y"], "it takes the position it was dropped on");
});

test("a group emptied of cards can be filled again", () => {
  // The section itself is a drop target for exactly this reason. Without it,
  // emptying a group made it permanently unusable.
  const before = view([section("s1", ["a"]), section("s2", [])]);
  const after = moveCardInView(before, "a", "s2");
  assert.deepEqual(idsIn(after, "s1"), []);
  assert.deepEqual(idsIn(after, "s2"), ["a"]);
});

test("dropping on another group's empty space appends to it", () => {
  const before = view([section("s1", ["a"]), section("s2", ["x", "y"])]);
  assert.deepEqual(idsIn(moveCardInView(before, "a", "s2"), "s2"), ["x", "y", "a"]);
});

test("a card never lands in two groups at once", () => {
  const before = view([section("s1", ["a", "b"]), section("s2", ["x"])]);
  const after = moveCardInView(before, "a", "x");
  const everywhere = after.sections.flatMap((s) => s.cards.map((c) => c.id));
  assert.deepEqual(everywhere.filter((id) => id === "a").length, 1);
  assert.equal(everywhere.length, 3, "and none are lost");
});

/* ── no-ops are the common case ───────────────────────────────────── */

/*
 * Dragover fires on every pointer movement and most of those events change
 * nothing. The editor detects that by REFERENCE — a no-op that returned a new
 * object describing the same arrangement would still be validated, recorded on
 * the undo stack and written to the server, dozens of times per drag. So these
 * assert identity, not equality.
 */

test("a card dropped on itself is a no-op", () => {
  const before = view([section("s1", ["a", "b"])]);
  assert.equal(moveCardInView(before, "a", "a"), before);
});

test("a card dropped where it already is, is a no-op", () => {
  const before = view([section("s1", ["a", "b", "c"])]);
  // "b" is already immediately before "c"; taking c's index changes nothing.
  const after = moveCardInView(before, "b", "b");
  assert.equal(after, before);
});

test("an unknown card or target is a no-op, not a crash", () => {
  const before = view([section("s1", ["a"])]);
  assert.equal(moveCardInView(before, "ghost", "a"), before);
  assert.equal(moveCardInView(before, "a", "ghost"), before);
  assert.equal(moveCardInView(before, "ghost", "ghost"), before);
});

test("cards nested in a container are not moved by this", () => {
  // They are not drag targets on this canvas — the container's own controls
  // reorder them. Descending here would move a card the drag layer never
  // offered, from a gesture aimed at something else.
  const container = {
    id: "grid-1",
    type: "grid",
    span: 2,
    columns: 2,
    cards: [card("inner")],
  } as unknown as CardConfig;
  const before = view([{ id: "s1", columnSpan: 1, cards: [container, card("a")] }]);
  assert.equal(moveCardInView(before, "inner", "a"), before);
});

/* ── the editor's own rules ───────────────────────────────────────── */

test("no side effect runs inside a setState updater", () => {
  /*
   * `update` did its work inside `setConfig(current => ...)`, which put a toast,
   * an undo push, a setUndoDepth and a scheduled save inside a function React
   * requires to be PURE and is free to call more than once.
   *
   * This was first blamed for the error page. It was not the cause - capturing
   * the browser error showed dnd-kit layout animation, covered below. It is a
   * real defect regardless: a replayed updater pushes undo entries that never
   * happened and schedules saves nobody asked for, and it does so
   * nondeterministically, which is the worst way for an editor to be wrong.
   */
  const provider = code(PROVIDER);
  assert.doesNotMatch(
    provider,
    /setConfig\(\s*\(/,
    "setConfig must be given a value, never an updater function",
  );
  assert.match(provider, /configRef\.current/, "…the previous config comes from a ref instead");
});

test("a change that returns its input unchanged does nothing at all", () => {
  const provider = code(PROVIDER);
  const fn = provider.slice(provider.indexOf("const update = useCallback"));
  const body = fn.slice(0, fn.indexOf("[persist],"));
  assert.match(body, /if \(next === current\) return;/);
  // …and before the expensive part, or it would save nothing very slowly.
  assert.ok(
    body.indexOf("if (next === current) return;") < body.indexOf("parseConfigStrict"),
    "the check must come before validation, not after",
  );
});

test("an echo of this editor's own save never re-seeds the screen", () => {
  /*
   * Every save calls revalidatePath("/"), so the arrangement comes back about a
   * second later — by which time the user has usually moved something else.
   * Adopting the echo put the older arrangement back on screen: the cards
   * jumping back that was reported.
   */
  const provider = code(PROVIDER);
  const effect = provider.slice(provider.indexOf("const seed = JSON.stringify"));
  const body = effect.slice(0, effect.indexOf("}, [seed]);"));

  const echoAt = body.indexOf("ownSeeds.current.has(seed)");
  const seedAt = body.indexOf("setConfig(initialConfig)");
  assert.ok(echoAt !== -1 && seedAt !== -1, "both must be present");
  assert.ok(echoAt < seedAt, "the echo must be recognised before anything is re-seeded");
  // The echo branch has to LEAVE, not fall through to the re-seed below it.
  assert.match(body.slice(echoAt, seedAt), /return;/);
});

test("a foreign change never overwrites work that is not saved yet", () => {
  // Another tab's change is worth adopting, but not over the top of an edit
  // still in the debounce or in flight — that is the user's work, and our own
  // save is moments away and will settle it.
  const provider = code(PROVIDER);
  const effect = provider.slice(provider.indexOf("const seed = JSON.stringify"));
  const body = effect.slice(0, effect.indexOf("}, [seed]);"));
  const guard = /if \(inFlight\.current > 0 \|\| timer\.current !== null\) return;/;
  assert.match(body, guard);
  assert.ok(
    body.search(guard) < body.indexOf("setConfig(initialConfig)"),
    "the guard must come before the re-seed",
  );
});

test("an edit inside the debounce survives leaving the page", () => {
  // The cleanup cleared the timer and stopped there, under a comment claiming it
  // flushed. An edit made within 600ms of navigating away was dropped outright —
  // no failure, no save, and the previous arrangement on return.
  const provider = code(PROVIDER);
  assert.match(provider, /pending\.current = next;/, "the debounced config must be held");
  assert.match(
    provider,
    /if \(unsaved\) void saveDashboardConfig\(/,
    "…and written on unmount rather than discarded",
  );
});

test("one drag is one undo step", () => {
  // Dragover fires per pointer movement. Per-change history meant one drag left
  // fifteen entries on a twenty-five entry stack, so undo took fifteen presses
  // to reverse one motion and two drags pushed everything else off the end.
  const provider = code(PROVIDER);
  assert.match(
    provider,
    /if \(!gestureId \|\| gestureId !== gesture\.current\)/,
    "consecutive changes in one gesture must not each push history",
  );

  const canvas = code(CANVAS);
  assert.match(canvas, /dragGesture\.current = `drag-/, "a drag must mint a gesture id");
  assert.match(canvas, /dragGesture\.current \?\? undefined/, "…and pass it with every move");
  assert.match(canvas, /dragGesture\.current = null/, "…and end it when the drag ends");
});

test("the drop position is drawn, not implied", () => {
  // The order already updated live, so the destination cell was on screen — with
  // nothing marking it but 30% opacity on a card that otherwise looked like
  // every other card. Reported as: you cannot see where it will slot in.
  // The marker is its own element now, drawn in the destination slot rather
  // than on the dragged card - tests/dashboardDropPreview.test.ts checks that
  // the position it promises is the position the drop delivers.
  const canvas = read(CANVAS);
  assert.match(canvas, /function DropMarker\(\)/, "there must be a marker");
  assert.match(canvas, /border-dashed border-primary/);
  assert.match(canvas, /\{isDragging && \(/, "and the card being moved must be marked as the source");
  assert.match(canvas, /dropAt !== null &&/, "and the receiving group outlined");
});

test("the pointer decides the target, not the nearest centre", () => {
  /*
   * closestCenter measures dragged-centre to droppable-centre, which suits a list
   * of equal rows and not a grid of one-to-four column cards: the nearest centre
   * is regularly not the card under the pointer.
   *
   * Cards must beat sections, or the section droppable underneath every card
   * wins on distance and the card jumps to the end of the group each time it
   * passes over one.
   */
  const canvas = code(CANVAS);
  assert.match(canvas, /pointerWithin\(args\)/);
  assert.doesNotMatch(
    canvas,
    /collisionDetection=\{closestCenter\}/,
    "closestCenter must not be the primary strategy",
  );
  assert.match(canvas, /closestCenter\(args\)/, "…but it stays as the keyboard-sensor fallback");
  assert.match(canvas, /cardIds\.has\(String\(collision\.id\)\)/, "cards must be preferred");
});

test("the move maths reads one copy of the document", () => {
  // It was computed half in the handler, from the `view` prop, and half inside
  // the updater, against `current`. Dragover fires faster than React renders, so
  // the two were routinely different documents and the card landed a position
  // out. Everything now derives from the view the mover is handed.
  // The move now runs once, on the drop, rather than on every dragover - but the
  // rule is the same one: it derives from the view it is handed, not from the
  // props captured when the handler was created.
  const canvas = code(CANVAS);
  const handler = canvas.slice(canvas.indexOf("function onDragEnd"));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.match(body, /moveCardInView\(current,/);
  assert.doesNotMatch(body, /from\.cards|toSection\.cards/, "no indices from the props");
});

/* ── the crash the drag actually produced ─────────────────────────── */

test("layout animation is refused, not just the sorting strategy", () => {
  /*
   * The strategy was already NO_TRANSFORM, because these cards are different
   * sizes and transform-based previews send them to visibly wrong places. But
   * `animateLayoutChanges` is a SEPARATE mechanism and defaulted ON, so half of
   * "no transforms" never happened.
   *
   * On every index change useSortable's `useDerivedTransform` measures the card,
   * computes a FLIP delta and calls setState from a LAYOUT effect, with a second
   * effect that immediately sets it back to null — two renders per index change,
   * from the commit phase. Reordering happens on dragover, so the index changes
   * as fast as the pointer moves. Enough of those pairs nest in one commit to
   * pass React's limit, and React throws "Maximum update depth exceeded" during
   * commit, which the route's error boundary catches as an error page.
   *
   * The captured stack named the hook:
   *     at useDerivedTransform.useIsomorphicLayoutEffect (@dnd-kit/sortable)
   *     at commitHookLayoutEffects
   */
  const canvas = code(CANVAS);
  assert.match(canvas, /animateLayoutChanges: \(\) => false/, "FLIP animation must be refused");
  assert.match(canvas, /strategy=\{NO_TRANSFORM\}/, "…and the strategy stays off too");
});

test("the sortable item list is stable between renders", () => {
  // dnd-kit compares this array BY IDENTITY to decide whether the list changed —
  // it gates the layout-animation decision on `previousItems !== items`. A fresh
  // array each render answered "just changed" continuously for a list that had
  // not changed at all.
  const canvas = code(CANVAS);
  assert.match(canvas, /items=\{sortableItems\}/, "must not build the array inline");
  assert.match(canvas, /const sortableItems = useMemo\(/);
  // Keyed on a string, because every edit rebuilds the card objects and an array
  // of them would be a new dependency on every render.
  assert.match(canvas, /\[cardIdKey, section\.id\]/);
});

test("no hook sits below a conditional return", () => {
  /*
   * SectionBlock returns null for an empty section outside edit mode. A hook
   * after that runs a different number of hooks on the render where the
   * condition flips, and React ends it with "Rendered more hooks than during the
   * previous render".
   */
  const canvas = code(CANVAS);
  const block = canvas.slice(canvas.indexOf("function SectionBlock"));
  const body = block.slice(0, block.indexOf("\n  return ("));
  const returnAt = body.indexOf("return null;");
  assert.ok(returnAt !== -1, "could not find the early return");
  const after = body.slice(returnAt);
  assert.doesNotMatch(after, /\buse[A-Z]\w*\(/, "no hook may follow the early return");
});
