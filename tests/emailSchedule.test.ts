import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { localInputValue, nextHalfHour, quickSendTimes } from "../src/lib/emailSchedule";

test("a chosen time goes at the next run of the cron — the hour or the half hour", () => {
  assert.equal(localInputValue(nextHalfHour(new Date(2026, 9, 15, 8, 10, 45))), "2026-10-15T08:30");
  assert.equal(localInputValue(nextHalfHour(new Date(2026, 9, 15, 8, 30, 0))), "2026-10-15T08:30");
  assert.equal(localInputValue(nextHalfHour(new Date(2026, 9, 15, 23, 45))), "2026-10-16T00:00");
});

test("the quick choices", () => {
  // Wednesday 15 October 2026, 14:10.
  const wed = quickSendTimes(new Date(2026, 9, 15, 14, 10));
  assert.deepEqual(wed.map((o) => [o.label, localInputValue(o.at)]), [
    ["In an hour", "2026-10-15T15:30"],
    ["Tomorrow 08:00", "2026-10-16T08:00"],
    ["Monday 08:00", "2026-10-19T08:00"],
  ]);
  // On a Sunday, Monday IS tomorrow: offered once.
  const sun = quickSendTimes(new Date(2026, 9, 18, 9, 0));
  assert.deepEqual(sun.map((o) => o.label), ["In an hour", "Tomorrow 08:00"]);
});

test("the cron runs on the hour and the half hour, which is what the composer offers", () => {
  const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
  assert.equal(crons.find((c) => c.path === "/api/cron/scheduled-emails")?.schedule, "*/30 * * * *");
});
