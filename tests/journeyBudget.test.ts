import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { NEVER_STOP, type StopSignal } from "../src/lib/stopSignal";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The journey engine can schedule 1000 records, process 50 events, and process
 * 40 runs of up to 20 steps — sequentially. It was admitted on a fixed 10-second
 * reserve and then ran to completion with no deadline at all, so it could exceed
 * the platform limit and be terminated mid-send.
 */

test("every sequential loop in the engine can stop", () => {
  // Guard counts, per file, so removing a check fails rather than passing
  // quietly because some OTHER loop still has one.
  const scheduling = src("src/lib/journeyScheduling.ts");
  const perRecordLoops = (scheduling.match(/for \(const (lead|contact|vehicle) of /g) ?? []).length;
  const guards = (scheduling.match(/stop\.shouldStop\(/g) ?? []).length;
  assert.ok(perRecordLoops >= 4, `expected the four enrolment loops, found ${perRecordLoops}`);
  assert.ok(
    guards >= perRecordLoops + 1,
    `every enrolment loop plus the per-journey loop must check the budget (loops=${perRecordLoops}, guards=${guards})`,
  );

  assert.match(
    src("src/lib/journeyEvents.ts"),
    /for \(const event of events\) \{\s*\n\s*if \(stop\.shouldStop\(/,
    "the event loop must check the budget before each event",
  );
  const runs = src("src/lib/journeyRuns.ts");
  assert.match(
    runs,
    /for \(const run of runs\) \{\s*\n\s*if \(stop\.shouldStop\(/,
    "the run loop must check the budget before each run",
  );
  assert.match(
    runs,
    /for \(let count = 0; count < MAX_STEPS_PER_TICK[^)]*\) \{[\s\S]{0,300}?stop\.shouldStop\(/,
    "the STEP loop must check the budget — a run is up to 20 sends",
  );
});

test("the cron hands its deadline down instead of only gating admission", () => {
  const route = src("src/app/api/cron/journeys/route.ts");
  assert.match(
    route,
    /runJourneyEngine\(budget\)/,
    "the engine must receive the route budget, not run unbounded once admitted",
  );
});

test("callers with no deadline are unaffected", () => {
  // A person pressing "enrol now" must not inherit a cron budget.
  const scheduling = src("src/lib/journeyScheduling.ts");
  assert.match(
    scheduling,
    /scheduleJourney\(journey, NEVER_STOP\)/,
    "the interactive enrolment path must opt out of stopping",
  );
  assert.equal(NEVER_STOP.shouldStop(), false);
  assert.equal(NEVER_STOP.shouldStop(10_000_000), false);
});

test("a signal that says stop halts a loop immediately", () => {
  // Behavioural proof of the contract the engine relies on, independent of the
  // engine's own database work.
  const budget: StopSignal = { shouldStop: (reserve = 0) => reserve >= 4_000 };
  const done: number[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    if (budget.shouldStop(4_000)) break;
    done.push(n);
  }
  assert.deepEqual(done, [], "a reserve larger than the remaining budget stops before the first unit");

  const roomy: StopSignal = { shouldStop: (reserve = 0) => reserve >= 100_000 };
  const all: number[] = [];
  for (const n of [1, 2, 3]) {
    if (roomy.shouldStop(4_000)) break;
    all.push(n);
  }
  assert.deepEqual(all, [1, 2, 3]);
});

test("a truncated run is visible rather than looking like a quiet tick", () => {
  assert.match(src("src/lib/journeys.ts"), /stoppedEarly/, "the engine must report being cut short");
});
