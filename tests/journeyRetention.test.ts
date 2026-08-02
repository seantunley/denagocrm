import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Nothing pruned journey traces. JourneyEvent, JourneyRun and JourneyStepLog
 * grew without bound — every event the engine has ever seen, every run, and a
 * log row per step of each. On a busy workspace that is the fastest-growing
 * data in the app and the data with the least long-term value.
 */

test("a live run is never pruned by age", () => {
  // THE ONE THAT MATTERS. A `waiting` run legitimately sits idle for WEEKS
  // between steps — that is what a drip sequence is. An age rule that ignored
  // status would delete journeys mid-flight and strand people halfway through
  // a sequence, and the symptom would be silence, not an error.
  const code = shipped("src/lib/journeyRetention.ts");
  // Anchor on `const stale =`, not on `journeyRun.findMany` — the FIRST
  // findMany is the protected-runs query, and anchoring there slices a window
  // that can never contain the status filter.
  const start = code.indexOf("const stale = await prisma.journeyRun.findMany");
  assert.notEqual(start, -1, "the stale-run query is gone — was it renamed?");
  // Bounded FROM the start; an unbounded indexOf can slice backwards to empty.
  const query = code.slice(start, code.indexOf("});", start));
  assert.ok(query.length > 0, "the slice ran backwards");
  assert.match(
    query,
    /status: \{ in: \["completed", "failed", "cancelled"\] \}/,
    "only CLOSED runs are eligible — queued/running/waiting/blocked are live state",
  );
});

test("a quiet journey still keeps a trace", () => {
  // An age-only rule empties the trace for a journey that rarely runs, which is
  // exactly the journey someone is most likely to be debugging. Home Assistant
  // keeps the last N per automation for this reason.
  const code = shipped("src/lib/journeyRetention.ts");
  assert.match(code, /RUNS_KEPT_PER_JOURNEY/, "a per-journey floor must exist");
  assert.match(code, /take: RUNS_KEPT_PER_JOURNEY/);
  assert.match(code, /id: \{ notIn: \[\.\.\.protectedIds\] \}/, "the floor must actually protect those runs");
});

test("pruning cannot starve the tick it runs in", () => {
  // Housekeeping must never win against sending. A tick that spent its budget
  // deleting instead of delivering would be the wrong trade every time.
  const engine = shipped("src/lib/journeys.ts");
  assert.match(engine, /stop\.shouldStop\(\) \? \{ events: 0, runs: 0 \} : await pruneJourneyTraces\(\)/);
  // The CALL, not the import — `pruneJourneyTraces` first appears on the import
  // line at the top of the file, which would make this ordering check backwards.
  const prune = engine.indexOf("await pruneJourneyTraces()");
  const process = engine.indexOf("processJourneyRuns(40");
  assert.ok(process < prune, `pruning must come after the work (process ${process}, prune ${prune})`);
  assert.match(shipped("src/lib/journeyRetention.ts"), /MAX_DELETES_PER_SWEEP/, "and be bounded per sweep");
});

test("deleting a run takes its step timeline with it", () => {
  // JourneyStepLog has no separate sweep, so it relies on the cascade. If that
  // relation ever loses onDelete: Cascade, every pruned run leaves its whole
  // step history orphaned and the table keeps growing anyway.
  assert.match(
    src("prisma/journeys.prisma"),
    /run\s+JourneyRun @relation\(fields: \[runId\], references: \[id\], onDelete: Cascade\)/,
    "JourneyStepLog must cascade from JourneyRun, or pruning leaves orphans",
  );
});
