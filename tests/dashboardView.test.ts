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

test("a card refused by a server-decidable rule is never rendered, so its query never runs", () => {
  const view = VIEW();
  const body = view.split("async function renderSection")[1] ?? "";
  assert.ok(body.length > 0, "could not isolate renderSection");

  const gate = body.indexOf("isServerDecidable(card.visibility)");
  const render = body.indexOf("await renderCard(");
  assert.ok(gate >= 0, "cards must be gated on their server-decidable conditions");
  assert.ok(render >= 0, "renderSection must render its cards");
  assert.ok(
    gate < render,
    "the visibility gate must run BEFORE renderCard, or the query the card would have issued has already happened and the condition is decoration",
  );
});

test("a section refused by a server-decidable rule loads none of its cards", () => {
  const body = VIEW().split("async function renderSection")[1] ?? "";
  const gate = body.indexOf("isServerDecidable(section.visibility)");
  const map = body.indexOf("section.cards.map");
  assert.ok(gate >= 0 && map >= 0);
  assert.ok(gate < map, "the section gate must precede its cards being walked at all");
});

test("data-dependent conditions are applied only AFTER the card has rendered", () => {
  // The complement of the first guard. A `data` condition needs the card's own
  // signals, so it cannot gate the query — and pretending otherwise would mean
  // reading signals that do not exist yet and hiding cards at random.
  const body = VIEW().split("async function renderSection")[1] ?? "";
  const render = body.indexOf("await renderCard(");
  const signals = body.indexOf("signals: result.signals");
  assert.ok(signals > render, "the signal-based check must come after the render");
});

test("one card that throws does not take the dashboard down", () => {
  const body = VIEW().split("async function renderSection")[1] ?? "";
  assert.match(
    body,
    /try \{\s*result = await renderCard\(card, render\);\s*\} catch \{\s*return null;/,
    "a renderer that throws must cost one card, not the home screen",
  );
});

test("a hidden section is distinguishable from an empty one", () => {
  // They render identically, and conflating them in the return type is how a
  // future change starts treating "you may not see this" as "there was nothing
  // in it" — at which point a permission failure looks like an empty state.
  assert.match(
    VIEW(),
    /Promise<\{ id: string; node: React\.ReactNode \}\[\] \| null>|Promise<CardSlot\[\] \| null>/,
    "renderSection must return null for a refused section, not an empty array",
  );
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
  // A stale bookmark that quietly shows a DIFFERENT tab's numbers is worse than
  // one that says the page is gone: the numbers look like an answer to the
  // question the URL asked.
  assert.match(
    src("src/components/dashboard/DashboardScreen.tsx"),
    /if \(!active\) notFound\(\);/,
    "an unresolved tab must 404",
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
