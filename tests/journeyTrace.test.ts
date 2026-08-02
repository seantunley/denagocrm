import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Journeys built on event triggers enrolled nobody, and the only symptom was
 * silence: an automation that never runs looks exactly like one that runs and
 * matches nobody. The engine was already recording events, runs and step logs
 * — nothing showed them, and nothing recorded WHY a journey was passed over.
 *
 * These guard the two halves of the fix: the decision is recorded, and the
 * "never fired" case is surfaced rather than left to be noticed by hand.
 */

test("every enrolment outcome is recorded, including the passed-over ones", () => {
  // The loop was bare `continue`s. A journey nobody emits for and a journey
  // whose filters did not match produced identical evidence: none.
  const code = shipped("src/lib/journeyEvents.ts");
  const start = code.indexOf("for (const journey of journeys)");
  assert.notEqual(start, -1, "the enrolment loop is gone — was it renamed?");
  // Bound the end search FROM the start: recoverStaleJourneyEvents has an
  // earlier journeyEvent.updateMany, and an unbounded indexOf finds that one,
  // slicing backwards to an empty string that passes every assertion.
  const loop = code.slice(start, code.indexOf("journeyEvent.update(", start));
  assert.ok(loop.length > 0, "the slice ran backwards");

  // Every early exit must record a verdict on its way out. A `continue` is fine
  // — a continue with no decisions.push before it is the original bug, so count
  // them: one push per skip, plus one for the enrolled case at the end.
  const skips = (loop.match(/\bcontinue;/g) ?? []).length;
  const pushes = (loop.match(/decisions\.push\(/g) ?? []).length;
  assert.ok(skips > 0, "the loop no longer skips anything — has it been rewritten?");
  assert.equal(pushes, skips + 1, `${skips} skips but ${pushes} recorded verdicts — one path exits silently`);

  for (const reason of [
    /no published version/,
    /listens for/,
    /trigger filters did not match/,
    /already enrolled for this event/,
  ]) {
    assert.match(loop, reason, `each distinct cause needs its own reason: ${reason}`);
  }
  assert.match(code, /data: \{ status: "processed", processedAt: new Date\(\), decisions \}/);
});

test("a skipped duplicate is not reported as a mismatch", () => {
  // enqueueJourneyRun returning false is the idempotency key doing its job.
  // Rendering that as "did not match" sends someone hunting a filter bug.
  const code = shipped("src/lib/journeyEvents.ts");
  assert.match(code, /reason: queued \? "enrolled" : "already enrolled for this event"/);
});

test("the trace answers 'has this trigger EVER fired'", () => {
  // The question a run list cannot answer: an empty list looks the same whether
  // the trigger is broken or the workspace is quiet.
  const trace = shipped("src/lib/journeyTrace.ts");
  assert.match(trace, /everSeen/, "the never-fired case must be distinguishable from a quiet one");
  assert.match(trace, /journeyEvent\.groupBy/);
  assert.match(trace, /JOURNEY_TRIGGERS\.map/, "every trigger the builder OFFERS must be listed, not only those seen");
});

test("the page leads with the broken-wiring case", () => {
  const page = shipped("src/app/(app)/journeys/activity/page.tsx");
  assert.match(page, /const neverFired = health\.filter\(\(row\) => !row\.everSeen\)/);
  assert.match(page, /never fired/i, "…and says so in words, not just a count");
  assert.match(page, /requireOwner\(\)/, "the trace exposes entity ids and must be gated");
});

test("an event predating tracing is not reported as 'nothing considered'", () => {
  // decisions is nullable by design. Rendering NULL as an empty list would
  // accuse every historic event of having matched nothing.
  const trace = shipped("src/lib/journeyTrace.ts");
  assert.match(trace, /if \(!Array\.isArray\(value\)\) return null;/);
  const page = shipped("src/app/(app)/journeys/activity/page.tsx");
  assert.match(page, /event\.decisions === null/, "null and empty must render differently");
  assert.match(page, /event\.decisions\.length === 0/);
});

test("the trace is reachable from the journeys screen", () => {
  // A diagnostic nobody can find is a diagnostic nobody uses.
  assert.match(shipped("src/app/(app)/journeys/page.tsx"), /href="\/journeys\/activity"/);
});
