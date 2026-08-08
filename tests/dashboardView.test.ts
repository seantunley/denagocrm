import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { localClock } from "../src/lib/dashboard/conditions";

/**
 * Guards for the render path — the code that turns a stored config into a
 * screen.
 *
 * These are mostly source contracts, for the reason the other dashboard suites
 * give: the renderer imports `server-only` and a PrismaClient, so it cannot be
 * imported here at all. What a source contract can still pin is the one thing
 * that matters most about this file and is invisible in any single result — the
 * ORDER in which the gates run.
 *
 * The ordering is the security model. A condition evaluated before the card
 * loads can prevent the query; the same condition evaluated after it has already
 * fetched the rows can only hide the box they are drawn in. Both look identical
 * on screen. Only the first one is worth anything.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const VIEW = () => src("src/components/dashboard/DashboardView.tsx");

/* ── the ordering ─────────────────────────────────────────────────── */

/*
 * `renderViewSlots` fills a map of card id -> rendered node rather than
 * returning a tree, because the layout that PLACES those nodes is a client
 * component (the drag surface) and cards themselves are server components that
 * run queries. The gating logic below lives in the standalone `fill()` helper
 * it calls once per card — that split is what these guards are anchored on.
 */

test("a card refused by a server-decidable rule is never rendered, so its query never runs", () => {
  const view = VIEW();
  const body = view.split("async function fill(")[1] ?? "";
  assert.ok(body.length > 0, "could not isolate fill()");

  const gate = body.indexOf("admittedUpFront(card.visibility, ctx)");
  const render = body.indexOf("await renderCard(");
  assert.ok(gate >= 0, "cards must be gated on their server-decidable conditions");
  assert.ok(render >= 0, "fill() must render its card");
  assert.ok(
    gate < render,
    "the visibility gate must run BEFORE renderCard, or the query the card would have issued has already happened and the condition is decoration",
  );
});

test("a section refused by a server-decidable rule loads none of its cards", () => {
  const body = VIEW().split("export async function renderViewSlots")[1] ?? "";
  const gate = body.indexOf("admittedUpFront(section.visibility, ctx)");
  const map = body.indexOf("section.cards.map");
  assert.ok(gate >= 0 && map >= 0, "could not find the section gate and its card loop");
  assert.ok(gate < map, "the section gate must precede its cards being walked at all");
});

test("data-dependent conditions are applied only AFTER the card has rendered", () => {
  // The complement of the first guard. A `data` condition needs the card's own
  // signals, so it cannot gate the query — and pretending otherwise would mean
  // reading signals that do not exist yet and hiding cards at random.
  const body = VIEW().split("async function fill(")[1] ?? "";
  const render = body.indexOf("await renderCard(");
  const signals = body.indexOf("conditionsMet(card.visibility, { ...ctx, signals: result.signals }");
  assert.ok(signals > render, "the signal-based check must come after the render");
});

test("one card that throws does not take the dashboard down", () => {
  const body = VIEW().split("async function fill(")[1] ?? "";
  assert.match(
    body,
    /try \{\s*result = await renderCard\(card, render\);\s*\} catch \{\s*return;/,
    "a renderer that throws must cost one card, not the home screen",
  );
});

test("a hidden card leaves no entry in the slot map, distinct from a card that is merely empty", () => {
  // Both end up absent from `slots`, and that is deliberate: the canvas already
  // treats "no node" as one case (see DashboardCanvas's placeholder), and a
  // second signal for "you may not see this" vs "there was nothing in it" would
  // be a distinction the client — which must not learn WHY a card is absent —
  // has no business making.
  const view = VIEW();
  assert.match(view, /export type CardSlots = Record<string, React\.ReactNode>;/);
  const body = view.split("async function fill(")[1] ?? "";
  assert.match(body, /if \(!admittedUpFront\(card\.visibility, ctx\)\) return;/);
  assert.match(body, /if \(!result\.node\) return;/);
});

test("the tab strip and the renderer ask the same question about which tabs exist", () => {
  // Two implementations is how a tab comes to exist that leads nowhere — or
  // worse, how a tab somebody hid stays in the strip advertising its title.
  const view = VIEW();
  assert.match(view, /export function visibleViews\(/, "one exported answer, used by both");
  const screen = src("src/components/dashboard/DashboardScreen.tsx");
  assert.match(screen, /visibleViews\(dashboard\.config, ctx\)/, "the chrome must use it too");
  assert.ok(
    !/config\.views\.filter/.test(screen),
    "the tab strip must not filter the views itself",
  );
});

test("an unknown tab is a 404, not a silent fallback to the first one", () => {
  /*
   * A stale bookmark that quietly showed a DIFFERENT tab's numbers would be
   * worse than one that says the page is gone: the numbers would look like an
   * answer to the question the URL asked. Renaming a tab changes its `path`, so
   * it is tempting to fall back "for editing's sake" — but edit-mode tab
   * switching is local React state and never navigates (see DashboardScreen's
   * header comment), so a rename in progress cannot produce this URL for the
   * person doing the renaming. The 404 only ever fires for a genuinely dead
   * link, which is when it should.
   */
  const screen = src("src/components/dashboard/DashboardScreen.tsx");
  assert.match(screen, /import \{ notFound \} from "next\/navigation";/);
  assert.match(
    screen,
    /if \(tab && views\.length > 0 && !views\.some\(\(view\) => view\.path === tab\)\) notFound\(\);/,
    "a named tab that does not resolve must 404, not silently render a different one",
  );
  assert.ok(
    !/\?\? views\[0\] \?\? null;\s*$/m.test(screen.split("notFound();")[1] ?? ""),
    "the fallback-to-first must not apply when a tab was explicitly requested",
  );
});

/* ── the clock a time condition is judged against ─────────────────── */

test("time conditions are judged on the workspace's clock, not the server's", () => {
  /*
   * The server runs in UTC. On a UTC clock a South African working day starts at
   * five in the morning, so a card configured to show between 07:00 and 17:00
   * would appear two hours early and vanish two hours early. Nobody reports that
   * as a timezone bug — they report that the dashboard is wrong in the
   * afternoon.
   *
   * 08:30 UTC is 10:30 in Johannesburg: 630 minutes, not 510.
   */
  const { minutes, weekday } = localClock(new Date("2026-08-05T08:30:00.000Z"));
  assert.equal(minutes, 10 * 60 + 30, "the local clock must be the workspace's");
  assert.equal(weekday, 3, "5 August 2026 is a Wednesday");
});

test("the local clock rolls the date over correctly near midnight", () => {
  // 22:30 UTC is 00:30 the NEXT day locally. A window like "after 22:00" must
  // not match it, and the weekday must have advanced.
  const { minutes, weekday } = localClock(new Date("2026-08-05T22:30:00.000Z"));
  assert.equal(minutes, 30, "half past midnight is 30 minutes past midnight, not 1350");
  assert.equal(weekday, 4, "it is already Thursday locally");
});

test("the whole request shares one clock", () => {
  // Two cards deciding visibility from clocks a few milliseconds apart could
  // straddle a `time` boundary and produce a screen where a card appears and the
  // heading above it does not.
  const viewer = src("src/lib/dashboard/viewer.ts");
  assert.match(viewer, /export const viewerConditionContext = cache\(/, "the context must be memoised");
  assert.match(
    viewer,
    /localClock\(window\.now\)/,
    "the clock must come from the render's shared window, not a fresh Date",
  );
  assert.ok(
    !/new Date\(\)/.test(viewer),
    "viewer.ts must not mint its own clock",
  );
});
