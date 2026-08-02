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
  // Anchor on `const candidates =`, not on `journeyRun.findMany` — there are two
  // of those and the other one is the protection query, so a bare anchor slices
  // a window that can never contain the status filter and passes vacuously.
  const start = code.indexOf("const candidates = await prisma.journeyRun.findMany");
  assert.notEqual(start, -1, "the candidate query is gone — was it renamed?");
  // Bounded FROM the start; an unbounded indexOf can slice backwards to empty.
  const query = code.slice(start, code.indexOf("});", start));
  assert.ok(query.length > 0, "the slice ran backwards");
  assert.match(
    query,
    /status: \{ in: CLOSED_RUN_STATUSES \}/,
    "only CLOSED runs are eligible — queued/running/waiting/blocked are live state",
  );
  // An ALLOWLIST, so a live status added later is excluded by default. The
  // whole point is that nobody has to remember to come back here.
  assert.match(
    code,
    /const CLOSED_RUN_STATUSES = \["completed", "failed", "cancelled"\]/,
    "the closed set must be an allowlist of terminal statuses, not a denylist",
  );
  for (const live of ["queued", "running", "waiting", "blocked"]) {
    assert.ok(
      !new RegExp(`CLOSED_RUN_STATUSES = \\[[^\\]]*"${live}"`).test(code),
      `"${live}" is a LIVE status and must never be in the closed set`,
    );
  }
});

test("the empty case costs one query, not one per journey", () => {
  // The cron runs this once PER TENANT per tick, and it deletes nothing on
  // almost all of them. The first version computed the per-journey floor up
  // front — a query per journey, per tenant, per tick, to find nothing. That
  // costs more than the growth it exists to control.
  const code = shipped("src/lib/journeyRetention.ts");
  assert.ok(
    !/prisma\.journey\.findMany/.test(code),
    "enumerating every journey up front is the N+1 this shape exists to avoid",
  );
  const earlyOut = code.indexOf("if (candidates.length === 0) return");
  assert.notEqual(earlyOut, -1, "the early-out is gone");
  const floorLoop = code.indexOf("for (const journeyId of journeyIds)");
  assert.notEqual(floorLoop, -1, "the per-journey floor loop is gone");
  assert.ok(
    earlyOut < floorLoop,
    `the floor must be computed only AFTER the early-out (early-out ${earlyOut}, loop ${floorLoop})`,
  );
});

test("the sweep makes progress instead of re-examining protected runs", () => {
  // Oldest-first matters. Newest-first fills the bounded window with
  // recent-but-past-cutoff runs that the per-journey floor then saves, so the
  // sweep deletes nothing while the backlog behind it keeps growing — a sweep
  // that runs forever and never catches up.
  const code = shipped("src/lib/journeyRetention.ts");
  const start = code.indexOf("const candidates = await prisma.journeyRun.findMany");
  const query = code.slice(start, code.indexOf("});", start));
  assert.match(query, /orderBy: \{ createdAt: "asc" \}/, "candidates must be oldest-first");
});

test("the early-out query has an index to use", () => {
  // Without it the early-out is a sequential scan of the largest tables in the
  // schema, once per tenant per tick, to find nothing.
  const schema = src("prisma/journeys.prisma");
  const migration = src("prisma/migrations/81_journey_retention_indexes/migration.sql");
  for (const table of ["JourneyEvent", "JourneyRun"]) {
    assert.match(
      migration,
      new RegExp(`CREATE INDEX IF NOT EXISTS "${table}_status_createdAt_idx"`),
      `${table} has no (status, createdAt) index — the sweep seq-scans it every tick`,
    );
  }
  assert.equal(
    (schema.match(/@@index\(\[status, createdAt\]\)/g) ?? []).length,
    2,
    "schema and migration must agree: both JourneyEvent and JourneyRun need the index",
  );
  // CONCURRENTLY cannot run inside Prisma's per-migration transaction. Using it
  // here would not trade a lock for availability — it would fail the migration
  // and ship no index at all.
  //
  // Comments stripped first: the migration's own prose explains at length why
  // CONCURRENTLY is absent, and a guard that reads the explanation as the
  // offence fails on the file that is doing the right thing.
  const statements = migration.replace(/^\s*--.*$/gm, "");
  assert.ok(
    !/CONCURRENTLY/.test(statements),
    "CREATE INDEX CONCURRENTLY fails inside Prisma's migration transaction",
  );
});

test("a quiet journey still keeps a trace", () => {
  // An age-only rule empties the trace for a journey that rarely runs, which is
  // exactly the journey someone is most likely to be debugging. Home Assistant
  // keeps the last N per automation for this reason.
  const code = shipped("src/lib/journeyRetention.ts");
  assert.match(code, /RUNS_KEPT_PER_JOURNEY/, "a per-journey floor must exist");
  assert.match(code, /take: RUNS_KEPT_PER_JOURNEY/);
  assert.match(
    code,
    /candidates\.filter\(\(run\) => !protectedIds\.has\(run\.id\)\)/,
    "the floor must actually remove protected runs from the delete set",
  );
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
