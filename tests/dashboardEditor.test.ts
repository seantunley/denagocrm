import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards for the dashboard editor.
 *
 * These are source contracts because the editor is a tree of client components
 * driving a DOM-measuring drag library, and there is no jsdom or renderer in
 * this suite. That is a real limit and it is worth being honest about what it
 * does and does not buy: none of this proves the editor WORKS. What it proves is
 * that the handful of decisions which were already bugs once cannot be quietly
 * undone — every one of these pins a property that is invisible when you read
 * the component, because it is about ordering, or about identity comparison, or
 * about which of two code paths a value came from.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const CANVAS = () => src("src/components/dashboard/editor/DashboardCanvas.tsx");
const PROVIDER = () => src("src/components/dashboard/editor/EditorProvider.tsx");
const ROOT = () => src("src/components/dashboard/editor/DashboardEditorRoot.tsx");
const VIEW = () => src("src/components/dashboard/DashboardView.tsx");

/* ── the drag rules, inherited rather than rediscovered ───────────── */

/*
 * All four of these were bugs in the first grid. They are re-asserted here
 * rather than trusted, because the editor's canvas is a SECOND drag surface
 * written months later, and "we already fixed that once" is not a property the
 * compiler checks.
 */

test("the canvas lays out from local config, never from the server's copy", () => {
  const canvas = CANVAS();
  // The nodes come from the server; the ORDER comes from the editing session. If
  // the layout were driven by a server-shaped list, a drop would change nothing
  // until a round trip completed and the card would visibly spring back.
  assert.match(canvas, /const \{ editing, updateView \} = useEditor\(\)/, "the canvas must read the working config");
  assert.match(
    canvas,
    /view\.sections\.filter|editing \? view\.sections/,
    "sections must be derived from the working view",
  );
});

test("the reorder happens on drag-over, not on drop", () => {
  const canvas = CANVAS();
  assert.match(canvas, /function onDragOver\(event: DragOverEvent\)/, "must handle drag-over");
  assert.match(canvas, /onDragOver=\{onDragOver\}/, "and wire it to the context");
  // onDragEnd must do nothing but end the drag. A reorder there means the grid
  // does not reflow under the pointer and the drop target is invisible.
  assert.match(
    canvas,
    /onDragEnd=\{\(_event: DragEndEvent\) => endDrag\(\)\}/,
    "drop must only end the drag; the move already happened on drag-over",
  );
  const end = canvas.split("function endDrag()")[1]?.split("\n  }")[0] ?? "";
  assert.ok(end.length > 0, "could not isolate endDrag");
  assert.doesNotMatch(end, /update|move/i, "ending a drag must not itself move anything");
});

test("no size-uniform sorting strategy is used", () => {
  const canvas = CANVAS();
  // These displace items by transform and assume every item has the same rect.
  // Dashboard cards span one to four columns with wildly different heights.
  assert.ok(
    !/rectSortingStrategy|rectSwappingStrategy|verticalListSortingStrategy|horizontalListSortingStrategy/.test(
      canvas,
    ),
    "a transform-based strategy sends mixed-size cards to visibly wrong places",
  );
  assert.match(canvas, /const NO_TRANSFORM: SortingStrategy = \(\) => null;/);
  assert.match(canvas, /strategy=\{NO_TRANSFORM\}/);
});

test("drop targets are re-measured continuously", () => {
  // The DOM genuinely reorders here, so rects captured at drag-start go stale
  // the moment the first swap happens. Symptom: works for one swap, then fights.
  const canvas = CANVAS();
  assert.match(
    canvas,
    /const MEASURE_ALWAYS = \{ droppable: \{ strategy: MeasuringStrategy\.Always \} \};/,
  );
  assert.match(canvas, /measuring=\{MEASURE_ALWAYS\}/);
});

test("an emptied section is still a drop target", () => {
  // Its own id goes in the sortable list. Without it, a section you emptied can
  // never be filled again — there is nothing left inside it to drop onto, and
  // the section becomes dead space that only deleting can clear.
  // The list is memoised now (dnd-kit compares it by identity), so the rule is
  // checked on what goes INTO it rather than on an inline array literal.
  const canvas = CANVAS();
  assert.match(canvas, /items=\{sortableItems\}/);
  assert.match(
    canvas,
    /\[\.\.\.\(JSON\.parse\(cardIdKey\) as string\[\]\), section\.id\]/,
    "the section id must be a droppable, or an empty group cannot be refilled",
  );
});

test("a card can be dragged between sections, not just within one", () => {
  const canvas = CANVAS();
  // Anchored on the full declaration: "const activeCard" is a PREFIX of
  // "const activeCardId", which appears earlier and would slice the body away.
  const over = canvas.split("function onDragOver")[1]?.split("const activeCard =")[0] ?? "";
  assert.ok(over.length > 0, "could not isolate the drag-over handler");
  /*
   * The move itself moved out to lib/dashboard/canvasMove, where it can be
   * executed rather than grepped — tests/dashboardCanvasMove.test.ts covers the
   * within-section, cross-section and empty-section cases against real configs.
   *
   * It moved because computing it here was the bug: the handler derived its
   * indices from the `view` prop and applied them inside the state updater to
   * `current`, and dragover fires faster than React renders, so those were
   * routinely different documents. What is left to check here is that the
   * handler still delegates, and still does not do that arithmetic itself.
   */
  assert.match(over, /moveCardInView\(current, activeCardId, overId\)/, "must delegate the move");
  assert.doesNotMatch(over, /splice|findIndex/, "no index arithmetic against the props");
});

/* ── saving ───────────────────────────────────────────────────────── */

test("a refused save puts the cards back where they were", () => {
  /*
   * Rolling back only the record of what is saved, and leaving the failed
   * arrangement on screen, is worse than not rolling back at all: the user
   * believes the change took, navigates away, and finds it gone later with no
   * explanation to connect it to.
   */
  const provider = PROVIDER();
  assert.match(provider, /const previous = committed\.current;/, "the last accepted config must be kept");
  assert.match(provider, /setConfig\(previous\);/, "a failure must restore the screen, not just the record");
  assert.match(provider, /toast\.error\(/, "and say so");
});

test("saves are coalesced so the server sees the arrangement the user stopped on", () => {
  // Dragging a card through four sections fires four config changes in about a
  // second. Four overlapping writes of a whole JSON document is both wasteful and
  // a way to have the second-to-last one land last.
  const provider = PROVIDER();
  assert.match(provider, /const SAVE_DEBOUNCE_MS = \d+;/, "there must be a debounce");
  assert.match(provider, /if \(timer\.current\) clearTimeout\(timer\.current\);/, "a pending save must be replaced");
});

test("a generated dashboard is materialised once, before its first write", () => {
  /*
   * A user who has never edited is looking at a config that was generated, not
   * stored, so there is no row to save into. Doing it transparently on the first
   * edit matters: asking somebody to press "Take control of this dashboard"
   * before they may move a card is a question about our data model, not about
   * anything they wanted to do.
   */
  const provider = PROVIDER();
  assert.match(provider, /const materialised = useRef<boolean>\(dashboardId !== null\);/);
  const persist = provider.split("const persist = useCallback")[1]?.split("const update =")[0] ?? "";
  const claim = persist.indexOf("await takeControl()");
  const save = persist.indexOf("await saveDashboardConfig(");
  assert.ok(claim > -1 && save > -1, "both calls must be present");
  assert.ok(claim < save, "the row must exist before anything is written into it");
  assert.match(persist, /materialised\.current = true;/, "and it must only happen once");
});

test("an edit is validated before it is persisted, with the same parser the action uses", () => {
  // The server would refuse it anyway, but a round trip later — by which time the
  // user has made three more edits and has no idea which one was rejected.
  const provider = PROVIDER();
  assert.match(provider, /const checked = parseConfigStrict\(next\);/, "must validate locally");
  assert.match(
    provider,
    /if \(!checked\.ok\) \{\s*toast\.error\(checked\.error\);\s*return;/,
    "and refuse the change, showing the parser's own message",
  );
});

test("a re-render with an unchanged server config does not clobber a live edit", () => {
  // `initialConfig` is a fresh object on every render of the page, so an
  // identity-compared effect fires DURING the save transition — while the server
  // still holds the previous config — and throws away the edit just made.
  const provider = PROVIDER();
  assert.ok(!/\}, \[initialConfig\]\)/.test(provider), "the re-seed must not depend on object identity");
  assert.match(provider, /const seed = JSON\.stringify\(initialConfig\);/, "compare by value");
  assert.match(provider, /if \(seenSeed\.current === seed\) return;/, "and no-op when unchanged");
});

test("card edits reach cards inside containers", () => {
  // A hand-rolled walk that forgot to descend into `grid`/`stack` would make
  // editing a nested card silently do nothing — the dialog would close, the
  // change would be gone, and nothing would report an error.
  const provider = PROVIDER();
  for (const fn of ["mapCardTree", "filterCardTree"]) {
    const body = provider.split(`function ${fn}`)[1]?.slice(0, 400) ?? "";
    assert.match(body, /type === "grid" \|\| .*type === "stack"/, `${fn} must recurse into containers`);
    assert.match(body, new RegExp(`${fn}\\(`), `${fn} must call itself`);
  }
});

/* ── what edit mode has to be able to reach ───────────────────────── */

test("edit mode shows tabs and sections that their own rules are hiding", () => {
  /*
   * A tab hidden behind a rule is precisely the one you most need to open in
   * order to change that rule. Filtering it out of the only screen that can edit
   * it makes the rule unchangeable, and the alternative — an escape hatch
   * somewhere in settings — is a second place to manage tabs.
   */
  assert.match(
    ROOT(),
    /const shown = editing \? config\.views : views;/,
    "every tab must be reachable while editing",
  );
  assert.match(
    CANVAS(),
    /const sections = editing \? view\.sections : view\.sections\.filter/,
    "every section must be reachable while editing",
  );
});

test("a card with no rendered node is drawn as a labelled placeholder, not a hole", () => {
  // Two different situations land here and the copy has to tell them apart, or
  // the editor looks broken: a card just added has no node until the save
  // round-trips, and a card hidden by its own rule will never have one while
  // that rule holds.
  const canvas = CANVAS();
  assert.match(canvas, /function CardPlaceholder/);
  assert.match(canvas, /Will appear once saved/);
  assert.match(canvas, /Hidden right now by its own rule/);
  assert.match(canvas, /Switched off/);
});

/* ── the server contract the editor depends on ────────────────────── */

test("the client is given rendered nodes, never the means to render a card itself", () => {
  /*
   * This is the reason the whole editor is shaped the way it is. Cards run
   * database queries and their permission filtering happens before anything
   * reaches the browser; a client that could render one would need the data.
   * The map is keyed by id and a card absent from it is absent for a reason the
   * client does not need to know.
   */
  const view = VIEW();
  assert.match(view, /export type CardSlots = Record<string, React\.ReactNode>;/);
  assert.match(view, /export async function renderViewSlots\(/);
  const canvas = CANVAS();
  assert.ok(
    !/from "@\/lib\/dashboard\/compile"|runListQuery|runMetricQuery/.test(canvas),
    "the canvas must never reach the query layer",
  );
});

test("only the active tab is rendered on the server", () => {
  // Cards are queries. Rendering every tab so switching feels instant means a
  // five-tab dashboard fires every query on every visit, for a screen the user
  // looks at one fifth of.
  const screen = src("src/components/dashboard/DashboardScreen.tsx");
  assert.match(
    screen,
    /const slots = active \? await renderViewSlots\(active, ctx\) : \{\};/,
    "exactly one view's cards may be rendered per request",
  );
  assert.ok(
    !/views\.map\([\s\S]*renderViewSlots/.test(screen),
    "no path may render every tab's cards",
  );
});

/* ── the two dialogs where a wrong unit or a soft warning is a real defect ── */

const BUILDER = () => src("src/components/dashboard/editor/CardBuilder.tsx");
const CONDITIONS = () => src("src/components/dashboard/editor/ConditionEditor.tsx");

test("a gauge target is collected in rands and never pre-multiplied by the editor", () => {
  /*
   * gauge.tsx does the ONE conversion — rands in, cents compared — and says so
   * explicitly: "Whoever builds the editor: collect rands, store rands, do not
   * pre-multiply." An editor that multiplied here as well would silently double
   * every money target, and the failure is invisible in the UI: the ring would
   * just read low forever, which looks like slow progress rather than a bug.
   */
  const builder = BUILDER();
  assert.match(builder, /target: Math\.max\(1, Number\(e\.target\.value\)/, "the target must be stored as typed");
  assert.ok(
    !/target:\s*Math\.round\(.*\*\s*100\)/.test(builder),
    "the editor must not multiply a money target by 100 — gauge.tsx already does that once",
  );
});

test("a money filter value is collected in rands, matching the compiler's own conversion", () => {
  const builder = BUILDER();
  assert.match(builder, /\(rands\)/, "a money input must say so, or the unit is a guess");
  assert.ok(
    !/\*\s*100/.test(builder.split('case "money"')[1]?.slice(0, 600) ?? ""),
    "the money filter control must not pre-convert — compile.ts's coerceValue is the one place that happens",
  );
});

test("a screen-size visibility rule always shows a plain, unmissable warning", () => {
  /*
   * A screen condition can only be decided in the browser, which means whatever
   * it hides has ALREADY been sent there. isSecurityRelevant() exists so this
   * editor can say that plainly rather than let someone reach for a media query
   * believing it keeps something back. This is the one guard in the whole
   * editor suite that is about a WORDING choice rather than a code path, and it
   * is here because a softened or hidden version of this warning is how someone
   * ships a real access-control mistake believing they built a privacy control.
   */
  const editor = CONDITIONS();
  assert.match(editor, /isSecurityRelevant/, "the warning must be driven by the real detector, not a hand-rolled check");
  assert.match(
    editor,
    /already been sent there/i,
    "the warning must say the information is already delivered — not just 'hidden'",
  );
  assert.match(
    editor,
    /must never\s+be relied on/i,
    "the warning must say plainly that this is not a privacy control",
  );
  // Not a tooltip, not a title attribute, not conditionally rendered behind a
  // click — grep for the tell-tale signs of a warning someone can miss.
  assert.ok(!/title=".*already been sent/.test(editor), "the warning must not be hidden in a tooltip");
});

test("scope: mine is only offered where a source can actually narrow to the viewer", () => {
  // A source with no user-typed field compiles `mine` to "match nothing" (see
  // compile.ts's ownerPredicate). Offering the switch there is offering a
  // control that silently empties the card the moment it is touched.
  const builder = BUILDER();
  assert.match(
    builder,
    /type === "user"/,
    "the mine\/team switch must check for a user-typed field before it is offered",
  );
});
