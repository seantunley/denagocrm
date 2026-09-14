import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isFutureDay, johannesburgDateKey, futureActivityRefusal } from "../src/lib/activityDay";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * An activity scheduled for tomorrow could be ticked off today, from any of the
 * six surfaces that render a "done" control. That silently inflates completion
 * stats, marks a lead as followed up when nobody called, and takes the item off
 * tomorrow's agenda so it never happens.
 */

/* ── the rule itself, driven directly ─────────────────────────────── */

test("THE DAY BOUNDARY IS JOHANNESBURG'S, NOT THE SERVER'S", () => {
  /*
   * The bug this prevents is invisible in CI and obvious in production: Vercel
   * runs in UTC, so between 00:00 and 02:00 SAST the server's own day is still
   * "yesterday". Using the local day would make tomorrow's work briefly
   * completable, and today's refused, for two hours every night.
   *
   * 21:30 UTC on the 14th is 23:30 SAST on the SAME day; 22:30 UTC is 00:30
   * SAST on the 15th. A server-local comparison gets both wrong.
   */
  assert.equal(johannesburgDateKey(new Date("2026-09-14T21:30:00Z")), "2026-09-14");
  assert.equal(johannesburgDateKey(new Date("2026-09-14T22:30:00Z")), "2026-09-15");
  // Midnight UTC is already 02:00 SAST — the all-day-activity storage form.
  assert.equal(johannesburgDateKey(new Date("2026-09-15T00:00:00Z")), "2026-09-15");
});

test("tomorrow is refused; today is allowed however late in the day", () => {
  const now = new Date("2026-09-14T08:00:00Z"); // 10:00 SAST on the 14th
  assert.equal(isFutureDay(new Date("2026-09-15T08:00:00Z"), now), true, "tomorrow must be refused");
  assert.equal(isFutureDay(new Date("2026-09-20T08:00:00Z"), now), true, "next week must be refused");
});

test("A LATER TIME TODAY IS NOT 'THE FUTURE' — this is a DAY rule", () => {
  // The rep who makes the 15:00 call at 14:40 must be able to tick it off. An
  // instant comparison would refuse that, which is why the rule is per-day.
  const now = new Date("2026-09-14T12:40:00Z"); // 14:40 SAST
  assert.equal(isFutureDay(new Date("2026-09-14T13:00:00Z"), now), false, "later today must be allowed");
  assert.equal(isFutureDay(new Date("2026-09-14T21:59:00Z"), now), false, "23:59 SAST today must be allowed");
});

test("the past stays completable — this blocks the future, not overdue work", () => {
  const now = new Date("2026-09-14T08:00:00Z");
  assert.equal(isFutureDay(new Date("2026-09-13T08:00:00Z"), now), false, "yesterday must stay completable");
  assert.equal(isFutureDay(new Date("2026-01-02T08:00:00Z"), now), false, "long overdue must stay completable");
});

test("the refusal names the day, so it is not a dead end", () => {
  const message = futureActivityRefusal(new Date("2026-09-15T08:00:00Z"));
  assert.match(message, /15 September/, "the user must be told WHEN they can do it");
});

/* ── the guard is at the chokepoint, not in a component ───────────── */

test("EVERY COMPLETION PATH IS GUARDED, BECAUSE THE GUARD IS AT finishActivity", () => {
  /*
   * Six surfaces render a done control and all of them reach `finishActivity`
   * via completeActivity or completeActivityAssess. Putting the check in a
   * component would cover one and invite the next to forget.
   */
  const code = stripComments(src("src/app/actions/activities.ts"));
  const fn = code.slice(code.indexOf("async function finishActivity("));
  const body = fn.slice(0, fn.indexOf("export async function"));
  assert.match(body, /isFutureDay\(/, "finishActivity must refuse a future day");
  // Before the write, or it refuses an activity it has already completed.
  assert.ok(
    body.indexOf("isFutureDay(") < body.indexOf("prisma.activity.update"),
    "the guard must run BEFORE the status is written",
  );
  // Both public entry points must still funnel through it.
  assert.match(code, /completeActivity\b[\s\S]*?finishActivity\(/);
  assert.match(code, /completeActivityAssess\b[\s\S]*?finishActivity\(/);
});

test("the test-drive return path is deliberately NOT blocked", () => {
  /*
   * testDrives.ts also sets an activity done, but it records a drive actually
   * being RETURNED — an event that has happened. Refusing it would block the
   * return being logged, which is a real regression rather than a guard.
   */
  const code = stripComments(src("src/app/actions/testDrives.ts"));
  assert.match(code, /status: "done"/, "the return path still completes its activity");
  assert.doesNotMatch(code, /isFutureDay/, "…and must not inherit the day guard");
});
