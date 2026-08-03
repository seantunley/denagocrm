import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { NEVER_STOP, type StopSignal } from "../src/lib/stopSignal";
import { budgetStopUpdate } from "../src/lib/journeyRunState";

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
  // The step loop's guard must come before any step is executed. Measured by
  // position rather than a fixed character window, so explaining the guard in a
  // comment cannot break the assertion.
  const stepLoopAt = runs.indexOf("for (let count = 0; count < MAX_STEPS_PER_TICK");
  const stepStopAt = runs.indexOf("stop.shouldStop(", stepLoopAt);
  const firstExecuteAt = runs.indexOf("executeJourneyStep(", stepLoopAt);
  assert.ok(stepLoopAt > 0, "the step loop must exist");
  assert.ok(
    stepStopAt > stepLoopAt && stepStopAt < firstExecuteAt,
    "the STEP loop must check the budget before executing a step — a run is up to 20 sends",
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

test("a budget stop parks the run — it does not fail it", () => {
  // The first attempt at this simply `break`ed out of the step loop, which fell
  // through to the "exceeded MAX_STEPS_PER_TICK" throw. Its catch marked the
  // NOT-YET-EXECUTED step failed, incremented attempts, and after three budget
  // stops failed the journey permanently. Running out of time is not an error.
  const update = budgetStopUpdate("step-7", { some: "context" });

  assert.equal(update.status, "queued", "the run was claimed as running and must be released");
  assert.equal(update.currentStepId, "step-7", "it must resume on the SAME step, not skip it");
  assert.deepEqual(update.context, { some: "context" }, "the context must survive the stop");
  assert.ok(update.nextRunAt instanceof Date, "it must be eligible again");

  // The two fields whose presence would corrupt the run.
  assert.ok(!("attempts" in update), "a budget stop must not consume a retry attempt");
  assert.ok(!("lastError" in update), "a budget stop is not an error");
  assert.notEqual(update.status, "failed");
});

test("the stop branch parks and returns instead of falling through", () => {
  const runs = src("src/lib/journeyRuns.ts");
  const loopAt = runs.indexOf("for (let count = 0; count < MAX_STEPS_PER_TICK");
  assert.ok(loopAt > 0, "the step loop must exist");

  const stopAt = runs.indexOf("stop.shouldStop(", loopAt);
  assert.ok(stopAt > loopAt, "the step loop must check the budget");
  const stopBranch = runs.slice(stopAt, stopAt + 200);
  // `park()` is the helper; it must be the thing that calls budgetStopUpdate.
  assert.match(stopBranch, /await park\(\);/, "the stop branch must persist the parked state");
  assert.match(stopBranch, /return false;/, "the stop branch must RETURN, not break");
  assert.doesNotMatch(stopBranch.slice(0, 120), /\bbreak;/, "breaking here would fall past the park");
  assert.match(
    runs.slice(0, loopAt),
    /const park = async \(\) =>[\s\S]{0,400}budgetStopUpdate\(/,
    "park() must persist exactly the budget-stop shape",
  );
});

test("running out of PER-TICK steps parks the run — nesting made 20 steps normal", () => {
  // This used to `throw new Error("Journey exceeded 20 immediate steps…")`,
  // which was defensible when twenty immediate steps could only mean a runaway
  // definition. A `repeat` of forty passes reaches twenty legitimately, so the
  // throw would have failed every real loop after three ticks. What catches a
  // run that genuinely never ends is now the LIFETIME budget, which is durable.
  const runs = src("src/lib/journeyRuns.ts");
  assert.doesNotMatch(
    runs,
    /throw new Error\(`Journey exceeded \$\{MAX_STEPS_PER_TICK\}/,
    "exhausting the per-tick budget must not fail the run",
  );
  assert.match(runs, /MAX_STEPS_PER_RUN = \d+/, "a lifetime step budget must exist");
  assert.match(
    runs,
    /throw new AbortJourney\(`Journey exceeded \$\{MAX_STEPS_PER_RUN\}/,
    "the lifetime budget must abort — an unbounded loop is not worth retrying",
  );
  assert.match(
    runs,
    /stepsExecuted: run\.stepsExecuted|let stepsExecuted = run\.stepsExecuted/,
    "the lifetime count must be READ from the row, or it resets every tick",
  );
});

test("a budget stop preserves the frame stack and the lifetime count", () => {
  // Parking mid-repeat and resuming with an empty cursor would silently restart
  // the loop; resuming with stepsExecuted back at 0 would remove the only bound
  // on a run that never ends.
  const update = budgetStopUpdate("loop", { some: "context" }, {
    cursor: { stepId: "loop", frames: [{ kind: "repeat", step: "loop", iteration: 2, index: 1 }] },
    stepsExecuted: 37,
  });
  assert.deepEqual(update.cursor, {
    stepId: "loop",
    frames: [{ kind: "repeat", step: "loop", iteration: 2, index: 1 }],
  });
  assert.equal(update.stepsExecuted, 37);
  assert.ok(!("attempts" in update), "still not an attempt");
});

test("the outer loops break only where nothing has been claimed", () => {
  // Breaking is safe when no row has been moved out of its pending state.
  const events = src("src/lib/journeyEvents.ts");
  const loopAt = events.indexOf("for (const event of events) {");
  const claimAt = events.indexOf("journeyEvent.updateMany", loopAt);
  const stopAt = events.indexOf("stop.shouldStop(", loopAt);
  assert.ok(stopAt > loopAt && stopAt < claimAt, "the event budget check must precede the claim");
});

test("a truncated run is visible rather than looking like a quiet tick", () => {
  assert.match(src("src/lib/journeys.ts"), /stoppedEarly/, "the engine must report being cut short");
});
