import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/prismaRetentionSpy";

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

/**
 * `journeyRetention.ts` is `server-only` and imports a live PrismaClient, so the
 * unit runner cannot load it as shipped: the `server-only` marker package is not
 * installed (Next vendors it and swaps it in through an RSC export condition),
 * and `./db` builds a real client against DATABASE_URL.
 *
 * tsx compiles these tests to CommonJS, so both are swapped by intercepting the
 * module loader and then requiring the real module through it. That buys
 * BEHAVIOURAL tests of the sweep — the shipped function, its real queries, run
 * against an in-memory table — instead of reading its source and hoping.
 *
 * The `./db` swap is anchored on the REQUESTING file, so it cannot accidentally
 * hand the spy to some other module that happens to import the database.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request === "./db" && parent?.filename?.endsWith("journeyRetention.ts")) {
    return { prisma: spy.prisma };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const retention = createRequire(import.meta.url)(
  "../src/lib/journeyRetention.ts",
) as typeof import("../src/lib/journeyRetention");

const DAY = 24 * 60 * 60 * 1000;
/** Old enough that both cutoffs have passed, so seeding is about status, not age. */
const ANCIENT = Date.now() - 400 * DAY;

/**
 * `count` rows with strictly increasing createdAt, oldest first.
 *
 * `base` separates one group from another in time. Overlapping timestamps would
 * interleave two groups inside the bounded window and make the expected counts
 * depend on sort tie-breaking rather than on the rule under test.
 */
function backlog(
  prefix: string,
  count: number,
  extra: Record<string, unknown> = {},
  base = ANCIENT,
): spy.Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    createdAt: new Date(base + i),
    ...extra,
  }));
}

/** The 0-based index encoded in a seeded id, for oldest-first assertions. */
const seq = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));

test("one sweep deletes a bounded batch, not the whole expired event backlog", () => {
  // THE FINDING. `deleteMany` over the full expired set is correct in its result
  // and wrong in its cost: on a tenant with a year of events it is one statement
  // holding row locks over millions of rows, for longer than the cron tick it
  // runs inside. The run sweep already selected a bounded window and deleted by
  // id; the event sweep did not.
  const events = 5_000;
  spy.reset({ journeyEvent: backlog("event", events, { status: "processed" }) });

  return retention.pruneJourneyTraces().then((result) => {
    assert.equal(
      result.events,
      retention.MAX_DELETES_PER_SWEEP,
      "a single sweep must stop at the ceiling, however large the backlog",
    );
    assert.equal(spy.rows("journeyEvent").length, events - retention.MAX_DELETES_PER_SWEEP);

    // The ceiling is only worth anything if the DELETE itself is bounded.
    // Counting the result would still pass if the sweep issued one unbounded
    // statement and reported a truncated number, so assert on the call.
    const deletes = spy.calls.filter((call) => call.model === "journeyEvent" && call.op === "deleteMany");
    assert.equal(deletes.length, 1, "one delete per sweep");
    const ids = (deletes[0].args.where as { id: { in: string[] } }).id.in;
    assert.ok(Array.isArray(ids), "the delete must name the rows it removes, not re-run the age filter");
    assert.equal(ids.length, retention.MAX_DELETES_PER_SWEEP);
  });
});

test("the ceiling is a number a tick can actually afford", () => {
  // Read from the module rather than trusted blindly: every bound above is
  // expressed in terms of this, so a sweep could be "bounded" at a million and
  // pass them all.
  assert.equal(retention.MAX_DELETES_PER_SWEEP, 2_000);
});

test("the event backlog drains oldest-first, so successive ticks make progress", async () => {
  // Same reason the run sweep is oldest-first. A sweep that took an arbitrary
  // 2,000 would leave the oldest rows to be re-scanned on every tick forever.
  spy.reset({ journeyEvent: backlog("event", 5_000, { status: "processed" }) });

  const first = await retention.pruneJourneyTraces();
  assert.equal(first.events, 2_000);
  assert.ok(
    spy.rows("journeyEvent").every((row) => seq(row.id) >= 2_000),
    "the survivors of the first tick must be the NEWEST rows — the oldest go first",
  );

  const second = await retention.pruneJourneyTraces();
  const third = await retention.pruneJourneyTraces();
  assert.deepEqual([second.events, third.events], [2_000, 1_000]);
  assert.equal(spy.rows("journeyEvent").length, 0, "three ticks must clear a 5,000-row backlog");

  const fourth = await retention.pruneJourneyTraces();
  assert.equal(fourth.events, 0, "and a drained backlog must then cost nothing");
});

test("an event the engine has not finished with is never pruned", async () => {
  // `pending` is work not yet done. Deleting it drops a trigger on the floor,
  // and the symptom is a journey that never enrolled anyone — silence, not an
  // error. Only statuses the engine is finished with are eligible.
  spy.reset({
    journeyEvent: [
      ...backlog("pending", 3, { status: "pending" }),
      ...backlog("processed", 2, { status: "processed" }),
      ...backlog("failed", 2, { status: "failed" }),
    ],
  });

  const result = await retention.pruneJourneyTraces();
  assert.equal(result.events, 4, "processed and failed are done with; pending is not");
  assert.deepEqual(
    spy.rows("journeyEvent").map((row) => row.status),
    ["pending", "pending", "pending"],
  );
});

test("an event still inside the retention window is never pruned", async () => {
  // The window has to outlast the longest possible wait — a `wait_for_trigger`
  // polls JourneyEvent for up to JOURNEY_LIMITS.waitDays. Pruning an event a
  // parked run is still looking for turns a continue into a silent timeout.
  const at = (days: number) => new Date(Date.now() - days * DAY);
  spy.reset({
    journeyEvent: [
      { id: "just-inside", createdAt: at(retention.EVENT_RETENTION_DAYS - 1), status: "processed" },
      { id: "just-outside", createdAt: at(retention.EVENT_RETENTION_DAYS + 1), status: "processed" },
    ],
  });

  const result = await retention.pruneJourneyTraces();
  assert.equal(result.events, 1);
  assert.deepEqual(
    spy.rows("journeyEvent").map((row) => row.id),
    ["just-inside"],
  );
  assert.ok(
    retention.EVENT_RETENTION_DAYS > 30,
    "the window must exceed JOURNEY_LIMITS.waitDays, or a maximal wait races the sweep",
  );
});

test("a tick with nothing to prune issues no delete at all", async () => {
  // This runs once per tenant per tick and finds nothing on almost all of them.
  // Two indexed lookups — one per table — and no write.
  spy.reset({
    journeyEvent: backlog("fresh-event", 5, { status: "processed" }, Date.now()),
    journeyRun: backlog("live-run", 5, { status: "waiting" }),
  });

  const result = await retention.pruneJourneyTraces();
  assert.deepEqual(result, { events: 0, runs: 0 });
  assert.deepEqual(
    spy.calls.map((call) => `${call.model}.${call.op}`),
    ["journeyEvent.findMany", "journeyRun.findMany"],
    "the empty case must be two lookups and nothing else — no delete, no per-journey floor",
  );
  assert.equal(spy.rows("journeyRun").length, 5, "a waiting run is live state, not a trace");
});

test("the run sweep is bounded and still keeps every journey's most recent runs", async () => {
  // A quiet journey whose five closed runs are the OLDEST rows in the table,
  // then a busy journey with a 5,000-run backlog behind them, then three runs
  // still in flight. Everything here is far past the age cutoff, so age alone
  // would take the lot.
  //
  // The quiet journey sits inside the bounded window on purpose: putting it
  // outside would make its survival prove nothing except that the sweep never
  // looked at it.
  const quiet = backlog("quiet", 5, { status: "completed", journeyId: "quiet" }, ANCIENT);
  const busy = backlog("busy", 5_000, { status: "completed", journeyId: "busy" }, ANCIENT + 100_000);
  const waiting = backlog("waiting", 3, { status: "waiting", journeyId: "busy" }, ANCIENT + 200_000);
  spy.reset({ journeyRun: [...quiet, ...busy, ...waiting] });

  const result = await retention.pruneJourneyTraces();
  assert.equal(
    result.runs,
    retention.MAX_DELETES_PER_SWEEP - quiet.length,
    "the window holds 2,000 candidates; the five the floor rescues are simply not deleted",
  );

  const survivors = spy.rows("journeyRun");
  assert.equal(
    survivors.filter((row) => row.status === "waiting").length,
    3,
    "a waiting run is live state and must survive any age rule",
  );
  assert.equal(
    survivors.filter((row) => row.journeyId === "quiet").length,
    5,
    "a quiet journey's whole trace is inside the per-journey floor — it is exactly the journey you debug",
  );
  assert.ok(
    survivors.every((row) => row.journeyId !== "busy" || row.status !== "completed" || seq(row.id) >= 1_995),
    "the busy journey must lose its OLDEST closed runs first",
  );
});

test("the per-journey floor is not silently defeated by the sweep window", async () => {
  // A journey whose entire closed history fits inside the floor must lose
  // nothing, no matter how far past the age cutoff all of it is.
  spy.reset({
    journeyRun: backlog("kept", 20, { status: "completed", journeyId: "kept" }),
  });
  const result = await retention.pruneJourneyTraces();
  assert.equal(result.runs, 0, "20 runs with a floor of 20 leaves nothing to delete");
  assert.equal(spy.rows("journeyRun").length, 20);
});

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

test("a migration touching a journey table sorts AFTER the one that creates it", () => {
  // CI caught this on the first push and it is worth a permanent guard, because
  // the trap is invisible from the filename.
  //
  // scripts/apply-migrations.mjs orders by `Number.parseInt(name, 10)`, NOT
  // lexicographically. So `81_foo` sorts as 81 and every timestamped migration
  // sorts as a 14-digit number — meaning EVERY timestamped migration runs after
  // EVERY numeric one. The journey tables are created in a timestamped
  // migration, so a numerically-prefixed migration touching them runs long
  // before they exist and dies with `relation "JourneyEvent" does not exist`.
  const dir = path.join(root, "prisma/migrations");
  const order = (name: string) => Number.parseInt(name, 10);
  const names = readdirSync(dir).filter((n) => existsSync(path.join(dir, n, "migration.sql")));

  const creator = names.find((n) =>
    /CREATE TABLE[^;]*"JourneyRun"/.test(readFileSync(path.join(dir, n, "migration.sql"), "utf8")),
  );
  assert.ok(creator, "no migration creates JourneyRun — has the schema been reorganised?");

  const tables = /"(JourneyRun|JourneyEvent|JourneyStepLog|JourneyVersion)"/;
  const tooEarly = names.filter(
    (n) =>
      n !== creator &&
      order(n) < order(creator!) &&
      tables.test(readFileSync(path.join(dir, n, "migration.sql"), "utf8")),
  );
  assert.deepEqual(
    tooEarly,
    [],
    `these migrations touch a journey table but sort before ${creator} creates it — ` +
      "apply-migrations.mjs sorts by parseInt, so they need a timestamp prefix",
  );
});

test("the early-out query has an index to use", () => {
  // Without it the early-out is a sequential scan of the largest tables in the
  // schema, once per tenant per tick, to find nothing.
  const schema = src("prisma/journeys.prisma");
  const migration = src("prisma/migrations/20260803100000_journey_retention_indexes/migration.sql");
  for (const table of ["JourneyEvent", "JourneyRun"]) {
    assert.match(
      migration,
      new RegExp(`CREATE INDEX IF NOT EXISTS "${table}_tenantId_status_createdAt_idx"\\s*\\n\\s*ON "${table}"\\("tenantId", "status", "createdAt"\\)`),
      `${table} has no (tenantId, status, createdAt) index — the sweep seq-scans it every tick`,
    );
  }
  // tenantId must LEAD. The sweep runs inside a tenant scope, so the emitted
  // query is `tenantId = $1 AND status IN (…) AND createdAt < $2`. Ordered
  // (status, createdAt), a tenant with nothing to prune still walks every OTHER
  // tenant's expired entries before returning empty — the busiest workspace
  // would set the cost of the quietest one's early-out, on every tick.
  assert.equal(
    (schema.match(/@@index\(\[tenantId, status, createdAt\]\)/g) ?? []).length,
    2,
    "schema and migration must agree: both tables need the tenant-leading index",
  );
  assert.ok(
    !/@@index\(\[status, createdAt\]\)/.test(schema),
    "a tenant-blind (status, createdAt) index makes one workspace pay for all the others",
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

  // …but a plain CREATE INDEX blocks writes for the whole build, on the two
  // LARGEST tables in the schema — which is the very reason the sweep exists.
  // So the concurrent path has to be a runnable artifact, not a note in a
  // comment, and the migration has to point at it.
  const prebuild = src("scripts/prebuild-journey-retention-indexes.sql");
  for (const table of ["JourneyEvent", "JourneyRun"]) {
    assert.match(
      prebuild,
      new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${table}_tenantId_status_createdAt_idx"\\s*\\n\\s*ON "${table}"\\("tenantId", "status", "createdAt"\\)`),
      `the prebuild script must cover ${table}, or half the deploy still locks`,
    );
  }
  assert.match(
    migration,
    /scripts\/prebuild-journey-retention-indexes\.sql/,
    "the migration must name the script, or nobody deploying will know it exists",
  );
  // Interrupted CONCURRENTLY builds leave an INVALID index that Postgres does
  // not repair and the planner will not use. A script that does not say so
  // hands someone a silently unindexed table.
  assert.match(prebuild, /indisvalid/, "the script must say how to find a failed build");
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
