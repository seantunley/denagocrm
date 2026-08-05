import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DASHBOARD_CARDS,
  DASHBOARD_CARD_IDS,
  DEFAULT_LAYOUT,
  MAX_CARDS,
  WHEN_NOT_EMPTY,
  addableCards,
  canSeeCard,
  cardById,
  isConditional,
  normaliseLayout,
  visibleCards,
  type DashboardAccess,
  type DashboardCardId,
} from "../src/lib/dashboard/registry";
import { evaluateConditions } from "../src/lib/journeyTypes";

/**
 * Guards for the per-user dashboard.
 *
 * The registry is deliberately free of Prisma and `server-only` imports so these
 * can exercise the real visibility rules rather than a re-implementation of
 * them. The three things most worth proving are the three ways a dashboard goes
 * wrong: it shows someone data they cannot otherwise reach, it breaks when a
 * saved layout mentions a card that no longer exists, or it serves one person's
 * arrangement to another.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** A viewer holding exactly these permissions, with every module switched on. */
function viewer(permissions: string[], modules: string[] = ["core", "automotive"]): DashboardAccess {
  return { permissions: new Set(permissions), modules: new Set(modules) };
}

const EVERY_PERMISSION = [...new Set(DASHBOARD_CARDS.flatMap((c) => [...c.permissions]))];

/* ── the catalogue is coherent ────────────────────────────────────── */

test("every catalogue entry has a unique id drawn from the id tuple", () => {
  const ids = DASHBOARD_CARDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate card id in DASHBOARD_CARDS");
  assert.deepEqual(
    [...ids].sort(),
    [...DASHBOARD_CARD_IDS].sort(),
    "DASHBOARD_CARDS and DASHBOARD_CARD_IDS disagree about which cards exist",
  );
});

test("every card in the catalogue has a loader and renderer registered", () => {
  // cards.tsx imports Prisma and `server-only`, so it cannot be imported here.
  // Checking the source for each id as a map key still catches the real failure:
  // adding a registry entry and forgetting the implementation, which would throw
  // at render time on `DASHBOARD_CARD_IMPLS[meta.id].load()`.
  const impls = src("src/lib/dashboard/cards.tsx");
  for (const id of DASHBOARD_CARD_IDS) {
    assert.ok(
      impls.includes(`"${id}": card(`),
      `card "${id}" is in the registry but has no entry in DASHBOARD_CARD_IMPLS`,
    );
  }
});

test("the default layout is the whole catalogue and fits under the cap", () => {
  assert.deepEqual([...DEFAULT_LAYOUT], [...DASHBOARD_CARD_IDS]);
  assert.ok(
    DEFAULT_LAYOUT.length <= MAX_CARDS,
    "the default layout is longer than the cap, so a new user could not save it back",
  );
});

/* ── permission filtering: render AND picker ──────────────────────── */

test("a card the user lacks permission for is absent from the rendered dashboard", () => {
  // signing.view is the only key that grants "Out for signature".
  const withoutSigning = viewer(EVERY_PERMISSION.filter((k) => !k.startsWith("signing.")));
  const rendered = visibleCards([...DEFAULT_LAYOUT], withoutSigning).map((c) => c.id);
  assert.ok(
    !rendered.includes("out-for-signature"),
    "a viewer without signing.view was still shown the signing card",
  );
  // Control: the same layout DOES yield it once the permission is held.
  const withSigning = visibleCards([...DEFAULT_LAYOUT], viewer(EVERY_PERMISSION)).map((c) => c.id);
  assert.ok(withSigning.includes("out-for-signature"), "the control case should include the card");
});

test("a card the user lacks permission for is absent from the add-card picker", () => {
  // The picker is the quieter of the two leaks: the card's title and description
  // disclose that the feature and its data exist. An empty layout means every
  // card the viewer may see is offered, so anything missing here is missing
  // because of permissions.
  const withoutSigning = viewer(EVERY_PERMISSION.filter((k) => !k.startsWith("signing.")));
  const offered = addableCards([], withoutSigning).map((c) => c.id);
  assert.ok(
    !offered.includes("out-for-signature"),
    "the add-card picker offered a card the viewer has no permission to see",
  );
  assert.ok(
    addableCards([], viewer(EVERY_PERMISSION)).map((c) => c.id).includes("out-for-signature"),
    "the control case should offer the card",
  );
});

test("the picker and the renderer agree for every card and every single-permission viewer", () => {
  // The real risk is not one card being wrong, it is the two lists drifting.
  // For each permission in the catalogue, a viewer holding ONLY that key must be
  // offered exactly the cards that would render for them.
  for (const key of EVERY_PERMISSION) {
    const access = viewer([key]);
    const rendered = visibleCards([...DEFAULT_LAYOUT], access).map((c) => c.id).sort();
    const offered = addableCards([], access).map((c) => c.id).sort();
    assert.deepEqual(
      offered,
      rendered,
      `picker and renderer disagree for a viewer holding only ${key}`,
    );
  }
});

test("a card with no permission keys is visible to any signed-in user", () => {
  const alerts = cardById("system-alerts");
  assert.ok(alerts, "system-alerts should exist");
  assert.deepEqual([...alerts.permissions], [], "system-alerts is expected to be permissionless");
  assert.ok(
    canSeeCard(alerts, viewer([])),
    "a card declaring no permissions must still show for a user with none",
  );
});

/* ── module entitlement ───────────────────────────────────────────── */

test("a card belonging to a disabled module is hidden even from a fully privileged user", () => {
  const noAutomotive = viewer(EVERY_PERMISSION, ["core"]);
  const rendered = visibleCards([...DEFAULT_LAYOUT], noAutomotive).map((c) => c.id);
  const offered = addableCards([], noAutomotive).map((c) => c.id);
  for (const id of ["service-stats", "service-agenda", "service-due"] as const) {
    assert.ok(!rendered.includes(id), `${id} rendered with the automotive pack switched off`);
    assert.ok(!offered.includes(id), `${id} was offered with the automotive pack switched off`);
  }
  // Control: with the pack on and the same permissions, they come back.
  assert.ok(
    visibleCards([...DEFAULT_LAYOUT], viewer(EVERY_PERMISSION)).map((c) => c.id).includes("service-due"),
    "the control case should render the automotive cards",
  );
});

/* ── a saved layout that mentions a card that no longer exists ─────── */

test("a saved layout referencing an unknown card id degrades instead of crashing", () => {
  // The scenario: a card was removed in a later release, and this user's row
  // still names it. The page must lose one card, not blow up.
  const stored = ["pipeline-snapshot", "card-removed-in-a-later-release", "new-leads"];
  const normalised = normaliseLayout(stored);
  assert.deepEqual(
    normalised,
    ["pipeline-snapshot", "new-leads"],
    "an unknown card id should be dropped and the known ones kept in order",
  );
  // And it must not reach the renderer, which would index a missing impl.
  const rendered = visibleCards(
    stored as DashboardCardId[],
    viewer(EVERY_PERMISSION),
  ).map((c) => c.id);
  assert.deepEqual(rendered, ["pipeline-snapshot", "new-leads"]);
});

test("normaliseLayout rejects structurally invalid stored values", () => {
  assert.deepEqual(normaliseLayout(null), [...DEFAULT_LAYOUT], "null should fall back to the default");
  assert.deepEqual(normaliseLayout("nonsense"), [...DEFAULT_LAYOUT]);
  assert.deepEqual(normaliseLayout({ cards: [] }), [...DEFAULT_LAYOUT]);
  assert.deepEqual(normaliseLayout([1, 2, 3]), [], "non-string entries should be dropped");
  // An EMPTY array is a real choice — the user removed every card — and must be
  // preserved, or the remove button would look broken on the last card.
  assert.deepEqual(normaliseLayout([]), [], "an empty saved layout must stay empty");
});

test("normaliseLayout dedupes and caps", () => {
  assert.deepEqual(
    normaliseLayout(["new-leads", "new-leads", "pipeline-snapshot"]),
    ["new-leads", "pipeline-snapshot"],
    "a duplicated id would render the card twice and double its queries",
  );
  const overCap = Array.from({ length: MAX_CARDS + 10 }, (_, i) => DASHBOARD_CARD_IDS[i % DASHBOARD_CARD_IDS.length]);
  assert.ok(
    normaliseLayout(overCap).length <= MAX_CARDS,
    "a stored layout longer than the cap must be truncated on read",
  );
});

/* ── conditional cards ────────────────────────────────────────────── */

test("a hide-when-empty card is hidden at zero and shown above zero", () => {
  assert.equal(
    evaluateConditions(WHEN_NOT_EMPTY, { vars: { count: 0 } }),
    false,
    "an empty conditional card should be hidden",
  );
  assert.equal(evaluateConditions(WHEN_NOT_EMPTY, { vars: { count: 3 } }), true);
});

test("a card with no condition is always shown once permissions allow it", () => {
  const pipeline = cardById("pipeline-snapshot");
  assert.ok(pipeline);
  assert.equal(pipeline.condition, undefined, "pipeline-snapshot is expected to be unconditional");
  assert.equal(
    evaluateConditions(pipeline.condition ?? null, { vars: {} }),
    true,
    "an absent condition must evaluate true, not false",
  );
});

test("conditional cards are flagged so the picker can mark them", () => {
  assert.ok(isConditional(cardById("out-for-signature")!), "out-for-signature is conditional");
  assert.ok(isConditional(cardById("system-alerts")!), "system-alerts is conditional");
  assert.ok(!isConditional(cardById("pipeline-snapshot")!), "pipeline-snapshot is not conditional");
  // A conditional card the viewer may see must still be OFFERED — it is hidden
  // by its data, not by their privileges.
  assert.ok(
    addableCards([], viewer(EVERY_PERMISSION)).some((c) => c.id === "out-for-signature"),
    "a conditional card must still appear in the picker",
  );
});

test("permission filtering runs before conditions are evaluated", () => {
  // Order is the security model: a condition deciding whether a query runs would
  // make the query the disclosure. Asserted on the page's source because it is a
  // property of the sequence, not of any one function.
  const page = src("src/app/(app)/page.tsx");
  const filtered = page.indexOf("visibleCards(");
  const evaluated = page.indexOf("evaluateConditions(");
  assert.ok(filtered > -1, "the page must filter through visibleCards");
  assert.ok(evaluated > -1, "the page must evaluate card conditions");
  assert.ok(
    filtered < evaluated,
    "cards must be permission-filtered BEFORE their visibility conditions are evaluated",
  );
});

test("the dashboard reuses the shared condition evaluator rather than a second one", () => {
  const registry = src("src/lib/dashboard/registry.ts");
  const page = src("src/app/(app)/page.tsx");
  assert.match(
    registry,
    /from "@\/lib\/journeyTypes"/,
    "card conditions must use the shared JourneyConditionGroup type",
  );
  assert.match(
    page,
    /import \{ evaluateConditions \} from "@\/lib\/journeyTypes"/,
    "the page must evaluate conditions with the shared evaluator",
  );
});

/* ── the drag actually moves something ────────────────────────────── */

/*
 * These are source contracts because the grid is a client component driving a
 * DOM-measuring drag library, and there is no jsdom or renderer in this suite.
 * What they pin is not styling — it is the one defect that made the feature look
 * broken: the grid rendered straight from the SERVER's `cards` prop, so a drop
 * changed nothing on screen until the server action returned. Local state has to
 * be what is drawn, or there is no optimistic update at all.
 */

const GRID = () => src("src/components/dashboard/DashboardGrid.tsx");

test("the grid renders from local order, not straight from the server prop", () => {
  const grid = GRID();
  assert.match(
    grid,
    /const visibleIds = order\.filter\(\(id\) => byId\.has\(id\)\)/,
    "what is drawn must be derived from the local `order` state",
  );
  assert.match(
    grid,
    /\{visibleIds\.map\(\(id\) => \{/,
    "the grid must map the locally-ordered ids, so a drop moves a card immediately",
  );
  // The regression itself: mapping the prop puts the server back in charge of
  // the order and the optimistic update silently does nothing.
  assert.ok(
    !/\{cards\.map\(\(card\) => \(?\s*<SortableCard/.test(grid),
    "the grid must not render by mapping the `cards` prop directly",
  );
});

test("the drag reorders on drag-over and only saves on drop", () => {
  const grid = GRID();
  // Live reflow under the pointer. Without this the only feedback during a drag
  // is the overlay chip, and the drop target is invisible.
  assert.match(grid, /function onDragOver\(event: DragOverEvent\)/, "must handle drag-over");
  assert.match(
    grid,
    /onDragOver=\{onDragOver\}/,
    "the drag-over handler must be wired to the DndContext",
  );
  // Indices come from the FULL order, so a condition-hidden card keeps its slot.
  const overBody = grid.split("function onDragOver")[1]?.split("function onDragEnd")[0] ?? "";
  assert.ok(overBody.length > 0, "could not isolate the drag-over handler");
  assert.match(
    overBody,
    /prev\.indexOf\(String\(active\.id\)\)/,
    "the moved card's index must be resolved against the full order",
  );
  assert.match(
    overBody,
    /prev\.indexOf\(String\(over\.id\)\)/,
    "the drop target's index must be resolved against the full order",
  );
  assert.ok(
    !/visibleIds\.indexOf/.test(overBody),
    "indices must not come from the visible subset, or hidden cards get shuffled to the end",
  );
  // A drag that ends where it started must not write.
  const endBody = grid.split("function onDragEnd")[1]?.split("function onDragCancel")[0] ?? "";
  assert.ok(endBody.length > 0, "could not isolate the drag-end handler");
  assert.match(
    endBody,
    /every\(\(id, i\) => id === previous\[i\]\)\) return;/,
    "an unchanged arrangement must not be persisted",
  );
});

test("a cancelled drag restores the arrangement the user started from", () => {
  const grid = GRID();
  assert.match(grid, /beforeDrag\.current = order;/, "drag-start must snapshot the arrangement");
  assert.match(
    grid,
    /function onDragCancel\(\) \{\s*setActiveId\(null\);\s*setOrder\(beforeDrag\.current\);/,
    "a cancelled drag must put every card back",
  );
  assert.match(grid, /onDragCancel=\{onDragCancel\}/, "the cancel handler must be wired up");
});

test("the sortable strategy applies no transforms, because the cards are not uniform", () => {
  const grid = GRID();
  // rectSortingStrategy and its siblings displace the other items by transform,
  // which assumes every item has the same rect. These span 1-3 columns with
  // wildly different heights, so the preview lands in the wrong place.
  assert.ok(
    !/rectSortingStrategy|rectSwappingStrategy|verticalListSortingStrategy|horizontalListSortingStrategy/.test(
      grid,
    ),
    "no size-uniform sorting strategy may be used for a mixed-span grid",
  );
  assert.match(
    grid,
    /const NO_TRANSFORM: SortingStrategy = \(\) => null;/,
    "the strategy must return no transform",
  );
  assert.match(grid, /strategy=\{NO_TRANSFORM\}/, "SortableContext must use it");
  // Something still has to follow the cursor.
  assert.match(grid, /<DragOverlay/, "a drag overlay must give the user something in hand");
});

test("a re-render with an unchanged server layout does not clobber a local drag", () => {
  const grid = GRID();
  // `savedOrder` is a fresh array every server render. A reference-compared
  // effect fires during the save transition — while the server still holds the
  // OLD order — and yanks the dropped card back.
  assert.ok(
    !/\}, \[savedOrder\]\)/.test(grid),
    "the re-seed effect must not depend on the savedOrder array identity",
  );
  assert.match(
    grid,
    /const seedKey = `\$\{savedOrder\.join\(","\)\}\|\$\{presentIds\.join\(","\)\}`;/,
    "the re-seed must be keyed on the layout's contents",
  );
  assert.match(
    grid,
    /if \(seedRef\.current === seedKey\) return;/,
    "an unchanged server layout must not reset local state",
  );
});

test("a rendered card missing from the saved order is still drawn", () => {
  const grid = GRID();
  // Total by construction: the union can only ever grow the list, so no card
  // can fall off the home screen because the two lists disagreed.
  assert.match(
    grid,
    /function mergeOrder\(saved: readonly string\[\], present: readonly string\[\]\): string\[\] \{/,
    "the order and the rendered cards must be reconciled",
  );
  assert.match(
    grid,
    /return \[\.\.\.saved, \.\.\.present\.filter\(\(id\) => !seen\.has\(id\)\)\];/,
    "cards absent from the saved order must be appended, never dropped",
  );
  assert.match(
    grid,
    /useState<string\[\]>\(\(\) => mergeOrder\(savedOrder, presentIds\)\)/,
    "the initial order must be the reconciled one",
  );
});

/* ── one user's layout is never served to another ─────────────────── */

test("the layout read is keyed on the session user and takes no arguments", () => {
  // A source contract, not a live database test: there is no DB in the unit
  // suite. What it pins is the only way this could go wrong — a userId arriving
  // from OUTSIDE the session, whether as a function parameter or a `where` on
  // anything other than the resolved user.
  const data = src("src/lib/dashboard/data.ts");
  assert.match(
    data,
    /export const dashboardLayoutForViewer = cache\(\s*async \(\)/,
    "dashboardLayoutForViewer must take NO parameters, so no caller can name another user",
  );
  assert.match(
    data,
    /where: \{ userId: user\.id \}/,
    "the layout row must be selected by the session user's own id",
  );
  assert.match(
    data,
    /const \{ user \} = await dashboardViewer\(\);/,
    "the user must come from the session-resolved viewer",
  );
});

test("the layout write actions derive the user from the session, never from input", () => {
  const actions = src("src/app/actions/dashboard.ts");
  // Signatures: neither export may accept anything that could carry a user id.
  assert.match(
    actions,
    /export async function saveDashboardLayout\(cards: unknown\): Promise<ActionResult>/,
    "saveDashboardLayout must take only the card list",
  );
  assert.match(
    actions,
    /export async function resetDashboardLayout\(\): Promise<ActionResult>/,
    "resetDashboardLayout must take no parameters",
  );
  // Both must resolve the acting user themselves. A server action is reachable
  // by direct POST, so this is the whole authorization story for the write.
  const exportBodies = actions.split(/export async function /).slice(1);
  assert.equal(exportBodies.length, 2, "unexpected number of exported actions");
  for (const body of exportBodies) {
    assert.match(
      body,
      /const user = await requireUser\(\);/,
      "every exported dashboard action must resolve the acting user from the session",
    );
  }
  // And the only id ever written is that user's. Call sites only — the
  // declaration's own `userId` parameter is how the id gets in, and is fine.
  const callSites = [...actions.matchAll(/await writeLayout\(([^,]*),/g)].map((m) => m[1].trim());
  assert.ok(callSites.length >= 2, "expected both actions to write a layout");
  for (const arg of callSites) {
    assert.equal(
      arg,
      "user.id",
      "writeLayout must only ever be called with the session user's id",
    );
  }
});
