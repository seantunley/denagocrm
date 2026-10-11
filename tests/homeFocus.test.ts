import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { HOME_QUEUE_SIZE, MAX_HOME_NUMBERS, homeBriefLine, homeNumbers, type HomeFigures } from "../src/lib/home/focusRules";

/** The home screen: a few numbers with context, one line that sums the day up, and nothing the viewer may not see. */

const figures = (over: Partial<HomeFigures> = {}): HomeFigures => ({
  seesLeads: true, seesActivities: true, seesSigning: true,
  wonCents: 64_000_000, prevWonCents: 50_000_000, salesTargetCents: 200_000_000,
  openPipelineCents: 480_000_000, openDeals: 42, newLeads: 18, prevNewLeads: 20, overdueMine: 7, waitingSignature: 2, ...over,
});

test("never more than five numbers, in the order that matters, and every one has context and somewhere to go", () => {
  const numbers = homeNumbers(figures());
  assert.equal(MAX_HOME_NUMBERS, 5);
  assert.deepEqual(numbers.map((n) => n.key), ["sales", "pipeline", "new-leads", "overdue", "waiting"]);
  for (const n of numbers) {
    assert.ok(n.context.trim().length > 0, `${n.key}: a bare figure says nothing`);
    assert.match(n.href, /^\/[a-z]/, `${n.key}: leads to its records`);
  }
});

test("with a target the sales figure is progress toward it; without one it is compared with last month", () => {
  const withTarget = homeNumbers(figures())[0];
  assert.equal(withTarget.progress, 0.32);
  assert.match(withTarget.context, /^32% of .* target$/);
  assert.equal(withTarget.direction, undefined);
  assert.equal(homeNumbers(figures({ wonCents: 999_000_000 }))[0].progress, 1, "past the target is a full bar, not an overflowing one");

  const noTarget = homeNumbers(figures({ salesTargetCents: 0 }))[0];
  assert.equal(noTarget.progress, undefined);
  assert.deepEqual([noTarget.context, noTarget.direction], ["28% up on last month", "up"]);
  assert.deepEqual([homeNumbers(figures({ salesTargetCents: 0, wonCents: 25_000_000 }))[0].context, homeNumbers(figures({ salesTargetCents: 0, wonCents: 25_000_000 }))[0].direction], ["50% down on last month", "down"]);
  // Nothing to compare against is said plainly, not shown as an infinite rise.
  assert.equal(homeNumbers(figures({ salesTargetCents: 0, prevWonCents: 0 }))[0].context, "none by this day last month");
  assert.equal(homeNumbers(figures({ salesTargetCents: 0, prevWonCents: 0, wonCents: 0 }))[0].context, "same as last month");
  assert.equal(homeNumbers(figures({ newLeads: 20 }))[2].context, "level with last month");
});

test("red is used for exactly one thing: the viewer's own overdue work", () => {
  const numbers = homeNumbers(figures());
  assert.deepEqual(numbers.filter((n) => n.alert).map((n) => n.key), ["overdue"]);
  const clear = homeNumbers(figures({ overdueMine: 0 })).find((n) => n.key === "overdue");
  assert.deepEqual([clear?.alert, clear?.context], [false, "nothing past due"]);
});

test("a figure the viewer may not see is not shown as a zero — it is not shown", () => {
  assert.deepEqual(homeNumbers(figures({ seesLeads: false })).map((n) => n.key), ["overdue", "waiting"]);
  assert.deepEqual(homeNumbers(figures({ seesSigning: false, seesActivities: false })).map((n) => n.key), ["sales", "pipeline", "new-leads"]);
  assert.deepEqual(homeNumbers(figures({ seesLeads: false, seesActivities: false, seesSigning: false })), []);
});

test("the one line says how much needs you, and says so when nothing does", () => {
  assert.equal(homeBriefLine({ toContact: 3, overdueMine: 2, waitingSignature: 2, meetingsToday: 4 }), "2 follow-ups overdue and 3 deals worth contacting. 2 quotes are out for signature.");
  assert.equal(homeBriefLine({ toContact: 1, overdueMine: 0, waitingSignature: 1, meetingsToday: 0 }), "1 deal worth contacting. 1 quote is out for signature.");
  assert.equal(homeBriefLine({ toContact: 0, overdueMine: 1, waitingSignature: 0, meetingsToday: 0 }), "1 follow-up overdue.");
  // A quiet day is a good result and reads as one.
  assert.equal(homeBriefLine({ toContact: 0, overdueMine: 0, waitingSignature: 0, meetingsToday: 0 }), "Nothing needs you right now — a clear day.");
  assert.equal(homeBriefLine({ toContact: 0, overdueMine: 0, waitingSignature: 3, meetingsToday: 1 }), "Nothing needs you right now — 1 thing on today's agenda, and 3 quotes out for signature.");
});

test("the screen loads only what the viewer may see, and keeps the dashboards one click away", () => {
  const loader = readFileSync("src/lib/home/focus.ts", "utf8");
  // Each strand is gated by the permission for that kind of record.
  assert.match(loader, /seesLeads \? loadTodayLeads\(user, \{ mine \}\) :/);
  assert.match(loader, /seesActivities \? plannedActivities\(\) : null/);
  assert.match(loader, /seesSigning \? quotesOutForSignature\(\) : null/);
  // The viewer's overdue count is their OWN, whatever they may see of others'.
  assert.match(loader, /dueDate: \{ lt: todayStart \}, assignedToId: user\.id/);
  // Signing counts are over the viewer's own quote scope, not every request in the workspace.
  assert.match(loader, /prisma\.quote\.count\(\{ where: \{ \.\.\.\(await quoteWhere\(\)\), id: \{ in: ids \}/);
  assert.equal(HOME_QUEUE_SIZE, 6);

  const page = readFileSync("src/app/(app)/page.tsx", "utf8");
  assert.match(page, /const mine = !\(view === "all" && canSeeTeam\);/, "the team view is only for someone who may see the team");
  assert.match(page, /<FollowUpPrompts/, "the viewer's overdue prompts are never folded away");
  assert.doesNotMatch(page, /DashboardScreen/, "the dashboard is not loaded on the home screen");
  assert.match(page, /href=\{`\/d\/\$\{DEFAULT_DASHBOARD_SLUG\}`\}/, "it is one click away");
  // …and that address works for someone who never customised theirs.
  assert.match(readFileSync("src/app/(app)/d/[slug]/page.tsx", "utf8"), /slug === DEFAULT_DASHBOARD_SLUG \? defaultDashboard\(\) : null/);
  assert.match(readFileSync("src/components/dashboard/DashboardScreen.tsx", "utf8"), /href=\{`\/d\/\$\{entry\.slug\}`\}/);
});
