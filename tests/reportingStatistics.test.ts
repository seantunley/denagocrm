import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/prismaStatisticsSpy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A migration file with its `--` comments stripped — the STATEMENTS only.
 *
 * Every positional assertion below ("this backfill runs inside the RLS bypass",
 * "the column is widened before it is narrowed") works by comparing `indexOf`
 * offsets, and `indexOf` cannot tell a statement from a quotation of one. This
 * migration explains the bug it fixes by quoting the very statement that fixes
 * it: `UPDATE "Lead" SET "wonAt" = …` appears near the top, in the comment
 * explaining what FORCE RLS would do to it without the bypass. Read raw, the
 * first hit is that explanation — which sits ABOVE `SET app.bypass_rls` — so
 * the check fails the file for documenting itself well.
 *
 * Safe here because no string literal in this migration contains `--`; if one
 * ever does, this becomes a real parser rather than a regex.
 */
const statements = (rel: string) => src(rel).replace(/--[^\n]*/g, "");

/**
 * The Reports page answered "deals won per month, this year vs last" by
 * materialising a year of Lead rows into Node, twice, and bucketing them in a
 * nested filter loop. This is the pre-aggregation that replaces that: a
 * fine-grained day series kept for a bounded window, downsampled into a month
 * series kept long-term.
 *
 * `statistics.ts` is `server-only` and imports a live PrismaClient, so the unit
 * runner cannot load it as shipped. Both are swapped by intercepting the module
 * loader, the same way journeyRetention.test.ts does — which buys BEHAVIOURAL
 * tests of the real rollup, its real queries and its real SQL, run against
 * in-memory tables, rather than reading the source and hoping.
 *
 * `./tenantPredicate` is deliberately NOT swapped: the tenant scoping is part
 * of what is under test.
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
  if (request === "./db" && parent?.filename?.endsWith("statistics.ts")) {
    return { prisma: spy.prisma, basePrisma: spy.basePrisma };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const stats = require_("../src/lib/statistics.ts") as typeof import("../src/lib/statistics");
const time = require_("../src/lib/statisticsTime.ts") as typeof import("../src/lib/statisticsTime");
const scope = require_("../src/lib/tenantScope.ts") as typeof import("../src/lib/tenantScope");
const tenant = require_("../src/lib/tenant.ts") as typeof import("../src/lib/tenant");
const enforcement =
  require_("../src/lib/tenantEnforcement.ts") as typeof import("../src/lib/tenantEnforcement");

/**
 * The tenant every rollup in this file resolves to unless one is passed in.
 *
 * Enforcement is DORMANT in the unit runner, exactly as it is in production
 * today, so `statisticsTenantId()` falls back to the founding tenant rather than
 * to null — which is the behaviour under test, not a convenience. A bucket
 * written tenantless is invisible the moment enforcement is switched on.
 */
const TENANT = tenant.DEFAULT_TENANT_ID;

const DAY = 24 * 60 * 60 * 1000;
/**
 * 11:00 SAST on Tuesday 4 August 2026. Mid-morning, so no boundary is nearby.
 *
 * FROZEN, and passed explicitly into every rollup. Nothing in this file reads
 * the wall clock: a suite whose fixtures are placed relative to `Date.now()`
 * either passes or fails depending on what time of day CI runs, and a bucket
 * boundary test is precisely the kind that would.
 */
const NOW = new Date("2026-08-04T09:00:00.000Z");
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3600_000);

type LeadSeed = Partial<spy.SourceRow> & { id: string; createdAt: Date };
/**
 * A Lead fixture, with the LIFECYCLE DATES the database would already have.
 *
 * `wonAt` / `lostAt` are stamped here the way the Lead_sync_pipeline_forecast
 * trigger stamps them (migration 52): once, when the deal first reaches that
 * status. Defaulting them rather than making every fixture spell them out is
 * deliberate — a won deal seeded with a NULL `wonAt` is outside every range the
 * aggregate probes, so it is not counted at all, and a test that forgot one
 * would quietly assert against a zero it never noticed.
 */
const lead = (seed: LeadSeed): spy.Row => {
  const row: spy.Row = {
    status: "open",
    source: "website",
    assignedToId: null,
    valueCents: 0,
    deletedAt: null,
    // OWNED by default, which is what production looks like: migration
    // 20260722120000_tenant_people_isolation backfilled every legacy NULL and
    // the audit of 2026-08-10 found no un-owned Lead at all. A fixture defaulting
    // to NULL would silently test the fallback that no longer exists.
    tenantId: TENANT,
    updatedAt: seed.createdAt,
    wonAt: null,
    lostAt: null,
    ...seed,
  };
  if (row.status === "won" && !row.wonAt) row.wonAt = row.updatedAt;
  if (row.status === "lost" && !row.lostAt) row.lostAt = row.updatedAt;
  return row;
};

/** A stored bucket, as a long-running workspace would already have it. */
const storedBucket = (seed: {
  metric: string;
  period: string;
  bucketStart: Date;
  dimension?: string;
  count: number;
  sumCents: number;
  tenantId?: string;
}): spy.Row => {
  const tenantId = seed.tenantId ?? TENANT;
  const dimension = seed.dimension ?? "";
  return {
    id: stats.statisticBucketId(tenantId, seed.metric, seed.period as "day" | "month", seed.bucketStart, dimension),
    tenantId,
    metric: seed.metric,
    period: seed.period,
    bucketStart: seed.bucketStart,
    dimension,
    count: seed.count,
    sumCents: BigInt(seed.sumCents),
    computedAt: ago(9),
  };
};

/** A cursor that says "history is built, and consumed up to here". */
const builtCursor = (source: string, at: Date, id: string): spy.Row => ({
  id: stats.statisticCursorId(TENANT, source as "lead" | "jobcard"),
  tenantId: TENANT,
  source,
  cursorAt: at,
  cursorId: id,
  backfillFrom: null,
  backfilledAt: ago(30),
  updatedAt: ago(30),
});

const cursorFor = (source: string) =>
  spy.rows("statisticCursor").find((row) => row.source === source);

/** Every bucket of a metric, summed — the number a double count shows up in. */
const totalCount = (metric: string, period: string) =>
  bucketsFor(metric, period).reduce((sum, row) => sum + row.count, 0);

/** Buckets as plain comparable values, for "did these two runs agree" assertions. */
const snapshot = () =>
  spy.rows("statisticBucket")
    .map((row) => `${row.metric}|${row.period}|${row.bucketStart.toISOString()}|${row.dimension}=${row.count}/${row.sumCents}`)
    .sort();

const bucketsFor = (metric: string, period: string) =>
  spy.rows("statisticBucket").filter((row) => row.metric === metric && row.period === period);

/* ══════════════════════════════════════════════════════════════════════════
   THE TIMEZONE DECISION
   ══════════════════════════════════════════════════════════════════════════ */

test("a day bucket starts at SAST midnight, so a 00:30 lead is not filed under yesterday", () => {
  // THE BUG THIS EXISTS TO PREVENT. Servers run in UTC and the business runs in
  // SAST (UTC+2), so 00:30 on the 4th, locally, is 22:30 on the 3rd in UTC. A
  // UTC-day bucket files it under the 3rd, and the daily numbers are wrong for
  // two hours out of every twenty-four — silently, and only for the events
  // people work late enough to create.
  const justAfterSastMidnight = new Date("2026-08-03T22:30:00.000Z");
  assert.equal(
    time.startOfSastDay(justAfterSastMidnight).toISOString(),
    "2026-08-03T22:00:00.000Z",
    "22:30 UTC on the 3rd is 00:30 SAST on the 4th — the bucket must be the 4th's",
  );
  assert.equal(time.sastDayKey(justAfterSastMidnight), "2026-08-04");
  // And the instant one minute EARLIER belongs to the previous SAST day.
  assert.equal(time.sastDayKey(new Date("2026-08-03T21:59:00.000Z")), "2026-08-03");
});

test("month buckets are calendar months, not a fixed number of days", () => {
  // The page stepped by 30.44 days above a four-month range. Those bars were not
  // months: each one started a little further from the 1st than the last, so a
  // "monthly" chart silently mixed parts of two months into every bar.
  const starts = time.periodStarts("month", new Date("2025-09-15T00:00:00Z"), NOW);
  assert.equal(starts.length, 12, "15 Sep 2025 to 4 Aug 2026 spans twelve calendar months");
  assert.deepEqual(
    starts.map((start) => time.sastMonthKey(start)),
    ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02",
     "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"],
  );
  for (const start of starts) {
    assert.equal(time.sastDayKey(start).slice(8), "01", "every month bucket starts on the 1st");
    assert.equal(start.getTime(), time.startOfSastMonth(start).getTime(), "…and is idempotent");
  }
  // A leap February proves it is calendar arithmetic and not 28-or-31 hardcoded:
  // stepping through it lands on 1 March, not on 29 February plus a remainder.
  const jan2028 = time.startOfSastMonth(new Date("2028-01-15T00:00:00Z"));
  assert.equal(time.sastMonthKey(time.addPeriods("month", jan2028, 1)), "2028-02");
  assert.equal(time.sastDayKey(time.addPeriods("month", jan2028, 2)), "2028-03-01");
});

test("the axis label names the SAST day the bucket counts, not the server's UTC day", () => {
  // A bucket starting at 22:00 UTC is "the 4th" to the business and "the 3rd" to
  // a bare formatter running in UTC. The page used a bare formatter.
  const bucket = time.startOfSastDay(new Date("2026-08-04T09:00:00.000Z"));
  assert.equal(bucket.toISOString(), "2026-08-03T22:00:00.000Z");
  assert.match(time.sastBucketLabel("day", bucket), /^0?4 Aug$/);
  assert.match(time.sastBucketLabel("month", time.startOfSastMonth(bucket)), /^Aug 26$/);
});

test("a long range is charted on the coarse series and a short one on the fine series", () => {
  // The point of the ladder: a twelve-month view must read twelve rows, not 365.
  assert.equal(time.periodForRange(new Date(NOW.getTime() - 365 * DAY), NOW), "month");
  assert.equal(time.periodForRange(new Date(NOW.getTime() - 30 * DAY), NOW), "day");
  assert.equal(time.periodForRange(new Date(NOW.getTime() - 121 * DAY), NOW), "month");
  assert.equal(time.periodForRange(new Date(NOW.getTime() - 119 * DAY), NOW), "day");
});

/* ══════════════════════════════════════════════════════════════════════════
   IDENTITY — the idempotency primitive
   ══════════════════════════════════════════════════════════════════════════ */

test("a bucket's id is derived, so two runs computing it address the same row", () => {
  const args = ["t1", "deals_won", "day", new Date("2026-08-03T22:00:00Z"), "user-7"] as const;
  assert.equal(
    stats.statisticBucketId(...args),
    stats.statisticBucketId(...args),
    "the id must be a pure function of the bucket's natural key",
  );
  // …and must not collide across ANY of its components. A collision here is not
  // a crash, it is two tenants' numbers landing in one row.
  const ids = new Set([
    stats.statisticBucketId("t1", "deals_won", "day", new Date(0), ""),
    stats.statisticBucketId("t2", "deals_won", "day", new Date(0), ""),
    stats.statisticBucketId("t1", "deals_lost", "day", new Date(0), ""),
    stats.statisticBucketId("t1", "deals_won", "month", new Date(0), ""),
    stats.statisticBucketId("t1", "deals_won", "day", new Date(1), ""),
    stats.statisticBucketId("t1", "deals_won", "day", new Date(0), "x"),
  ]);
  assert.equal(ids.size, 6, "every component must be part of the identity");
  // The tenant is a REQUIRED component, not an optional prefix. A signature that
  // accepted null would mint `"|deals_won|…"` ids in the enforcement-dormant
  // mode every deployment runs in today — one id shared by every workspace.
  assert.ok(
    stats.statisticBucketId("t1", "deals_won", "day", new Date(0), "").startsWith("t1|"),
    "the id must carry its tenant, so an id built for one workspace cannot address another's row",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE ROLLUP
   ══════════════════════════════════════════════════════════════════════════ */

test("the rollup builds history on its first run and records where it got to", async () => {
  spy.reset({
    Lead: [
      lead({ id: "old", createdAt: ago(400), status: "won", valueCents: 50_000, assignedToId: "u1" }),
      lead({ id: "new", createdAt: ago(1), status: "won", valueCents: 25_000, assignedToId: "u1" }),
    ],
  });

  const result = await stats.rollUpStatistics(NOW);
  assert.equal(result.backfilled, 2, "both sources are backfilled on a cold start");

  // A 400-day-old lead is far outside the 35-day recompute window, so it can
  // only be here because backfill went to the full day horizon.
  const days = bucketsFor("deals_won", "day");
  assert.equal(days.length, 2, "both won deals have a day bucket");
  assert.ok(
    days.some((row) => row.bucketStart.getTime() === time.startOfSastDay(ago(400)).getTime()),
    "backfill must reach past the recompute window, or the page has no history to show",
  );

  const cursor = spy.rows("statisticCursor").find((row) => row.source === "lead");
  assert.ok(cursor?.backfilledAt, "backfill must be recorded, or every tick redoes it");
  assert.equal(cursor.cursorId, "new", "the cursor is the NEWEST row, not the last one processed");
});

test("a tick with nothing new costs one probe per source and writes nothing", async () => {
  // This runs once per tenant on every tick and finds nothing on almost all of
  // them, so the empty case is the case that has to be cheap. One indexed
  // keyset probe per source table, and no write at all.
  spy.reset({ Lead: [lead({ id: "l1", createdAt: ago(2) })] });
  await stats.rollUpStatistics(NOW);

  spy.calls.length = 0;
  const result = await stats.rollUpStatistics(NOW);

  assert.equal(result.recomputed, 0);
  assert.deepEqual(
    spy.calls.map((call) => `${call.model}.${call.op}`),
    [
      "statisticCursor.findMany",
      "lead.findFirst",
      "jobCard.findFirst",
      // The retention sweep's own early-out, which is one indexed lookup and
      // no delete when there is nothing past the horizon.
      "statisticBucket.findMany",
    ],
    "the empty case must be the cursor read, one probe per source, and the prune early-out",
  );
  assert.deepEqual(spy.writes(), [], "and no writes whatsoever");
});

test("re-running the rollup from a lost cursor reproduces the buckets exactly", async () => {
  // THE ONE THAT MATTERS. The whole feature is worthless if a replayed tick,
  // an overlapping cron, or a cursor that was rolled back can double a number —
  // and a doubled number does not look like a bug, it looks like a good month.
  //
  // The cursor is cleared between the two runs so the second one genuinely
  // RECOMPUTES rather than taking the early-out. That is the harder claim: not
  // "a repeat run does nothing" but "a repeat run that does everything again
  // arrives at exactly the same place".
  spy.reset({
    Lead: [
      lead({ id: "a", createdAt: ago(3), status: "won", valueCents: 100_000, assignedToId: "u1" }),
      lead({ id: "b", createdAt: ago(3), status: "won", valueCents: 250_000, assignedToId: "u2" }),
      lead({ id: "c", createdAt: ago(2), status: "lost", valueCents: 70_000 }),
      lead({ id: "d", createdAt: ago(1), source: "facebook" }),
    ],
  });

  await stats.rollUpStatistics(NOW);
  const first = snapshot();
  const rowCount = spy.rows("statisticBucket").length;
  assert.ok(rowCount > 0, "the first run must actually have produced buckets");

  spy.rows("statisticCursor").length = 0; // the cursor is gone; do it all again
  await stats.rollUpStatistics(NOW);

  assert.deepEqual(snapshot(), first, "a full recompute must land on the same numbers");
  assert.equal(
    spy.rows("statisticBucket").length,
    rowCount,
    "and must not have inserted a second copy of any bucket",
  );

  // Spelled out for the metric where doubling would be least visible.
  const won = bucketsFor("deals_won", "day");
  assert.equal(won.reduce((sum, row) => sum + row.count, 0), 2);
  assert.equal(won.reduce((sum, row) => sum + Number(row.sumCents), 0), 350_000);
});

test("a bucket is RECOMPUTED from source, never added to", async () => {
  // The direct proof that there is no accumulation anywhere: a bucket seeded
  // with a wrong value is corrected to the true one. An incrementing rollup
  // would leave 999 in place and add to it.
  const day = time.startOfSastDay(ago(2));
  spy.reset({
    Lead: [lead({ id: "a", createdAt: ago(2), status: "won", valueCents: 1_000, assignedToId: "u1" })],
    statisticBucket: [
      storedBucket({
        metric: "deals_won",
        period: "day",
        bucketStart: day,
        dimension: "u1",
        count: 999,
        sumCents: 999_999,
      }),
    ],
  });

  await stats.rollUpStatistics(NOW);

  const bucket = bucketsFor("deals_won", "day").find((row) => row.dimension === "u1");
  assert.equal(bucket?.count, 1, "the bucket must hold what source says, not source plus history");
  assert.equal(Number(bucket?.sumCents), 1_000);
});

test("trashing a lead removes it from its bucket", async () => {
  // Two things fail together if this breaks, and both are quiet. The soft
  // delete must be SEEN — the probe reads the unfiltered client precisely
  // because the scoped one hides trashed rows, so through it the change would
  // be invisible. And the aggregate must EXCLUDE it — basePrisma is not a
  // soft-delete client, so the filter is written out by hand.
  // Asserted on `leads_created`, which buckets by the IMMUTABLE `createdAt`, so
  // a trashed lead can only leave its bucket by being filtered out — there is no
  // second mechanism that could produce the same drop and let a missing filter
  // pass as correct.
  spy.reset({
    Lead: [
      lead({ id: "keep", createdAt: ago(2), valueCents: 10_000 }),
      lead({ id: "trash", createdAt: ago(2), valueCents: 90_000 }),
    ],
  });
  await stats.rollUpStatistics(NOW);

  const day = time.startOfSastDay(ago(2));
  const bucket = () =>
    bucketsFor("leads_created", "day").find((row) => row.bucketStart.getTime() === day.getTime());
  assert.equal(bucket()?.count, 2);

  const trashed = spy.rows("Lead").find((row) => row.id === "trash")!;
  trashed.deletedAt = NOW;
  trashed.updatedAt = NOW;

  const result = await stats.rollUpStatistics(NOW);
  assert.equal(result.recomputed, 1, "the soft delete must be detected as a change");
  assert.equal(bucket()?.count, 1, "a trashed lead must stop counting");
  assert.equal(Number(bucket()?.sumCents), 10_000);
  assert.equal(
    bucketsFor("leads_created", "day").reduce((sum, row) => sum + row.count, 0),
    1,
    "…and must not reappear anywhere else in the series",
  );
});

test("a bucket emptied of every source row is deleted, not left on the chart", async () => {
  spy.reset({
    Lead: [lead({ id: "only", createdAt: ago(2), status: "won", valueCents: 10_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);
  assert.equal(bucketsFor("deals_won", "day").length, 1);

  const only = spy.rows("Lead").find((row) => row.id === "only")!;
  only.deletedAt = NOW;
  only.updatedAt = NOW;
  await stats.rollUpStatistics(NOW);

  assert.equal(
    bucketsFor("deals_won", "day").length,
    0,
    "a bucket nobody will overwrite is a number that stays on the chart for ever",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE BUCKET DATE — the one that must never move
   ══════════════════════════════════════════════════════════════════════════ */

test("a deal edited after its bucket sealed is not counted a second time", async () => {
  // THE WORST BUG THIS FEATURE CAN HAVE, and the reason every metric buckets on
  // an immutable lifecycle date.
  //
  // Bucket a won deal by `Lead.updatedAt` and this happens: the deal is won in
  // April, April's bucket records it, April falls out of the 35-day window and
  // is SEALED. In August someone opens the deal and adds a note. `updatedAt`
  // moves to August, the incremental rollup recomputes the open window, finds
  // the deal sitting in August and files it there too. April is outside the
  // window and keeps its count.
  //
  // One deal, two months, for ever. Nothing errors and both months look like
  // ordinary months — the total simply drifts upward every time anybody touches
  // an old record, and it never reconciles because the earlier bucket is the one
  // thing the rollup has promised never to look at again.
  spy.reset({
    Lead: [lead({ id: "old", createdAt: ago(140), wonAt: ago(100), status: "won", valueCents: 40_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);

  const sealedDay = time.startOfSastDay(ago(100));
  const sealedMonth = time.startOfSastMonth(ago(100));
  const inSealedDay = () =>
    bucketsFor("deals_won", "day").find((row) => row.bucketStart.getTime() === sealedDay.getTime());
  assert.ok(
    100 > stats.RECOMPUTE_WINDOW_DAYS,
    "the fixture must actually be outside the window, or this proves nothing",
  );
  assert.equal(inSealedDay()?.count, 1, "backfill must have built the old bucket first");
  assert.equal(totalCount("deals_won", "day"), 1, "one deal, counted once");

  // Someone adds a note in August. The deal was still won in April.
  const old = spy.rows("Lead").find((row) => row.id === "old")!;
  old.updatedAt = NOW;
  const result = await stats.rollUpStatistics(NOW);
  assert.equal(result.recomputed, 1, "the edit must still be SEEN — the probe watches updatedAt");

  assert.equal(inSealedDay()?.count, 1, "the sealed bucket is untouched — that is what sealing means");
  assert.equal(
    bucketsFor("deals_won", "day").find(
      (row) => row.bucketStart.getTime() === time.startOfSastDay(NOW).getTime(),
    ),
    undefined,
    "and the deal must NOT reappear in today's bucket — it was not won today",
  );
  assert.equal(totalCount("deals_won", "day"), 1, "still ONE deal across the whole day series");
  assert.equal(totalCount("deals_won", "month"), 1, "…and one across the whole month series");
  assert.equal(
    bucketsFor("deals_won", "month").find((row) => row.bucketStart.getTime() === sealedMonth.getTime())?.count,
    1,
    "the month that actually held the win still holds it",
  );
});

test("editing a deal inside the open window does not move it to a different day", async () => {
  // The same rule, checked where sealing cannot be doing the work. This bucket
  // IS recomputed — it is three days old — so if the bucket date could move, the
  // recompute would move it, and the chart would show the win on the day someone
  // last typed rather than the day the deal closed. The shape of every daily
  // chart in the app depends on this and nothing else enforces it.
  const wonDay = time.startOfSastDay(ago(3));
  spy.reset({
    Lead: [lead({ id: "w", createdAt: ago(9), wonAt: ago(3), status: "won", valueCents: 60_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);
  assert.equal(bucketsFor("deals_won", "day").length, 1);
  assert.equal(bucketsFor("deals_won", "day")[0].bucketStart.getTime(), wonDay.getTime());

  const won = spy.rows("Lead").find((row) => row.id === "w")!;
  won.updatedAt = NOW;
  await stats.rollUpStatistics(NOW);

  assert.equal(bucketsFor("deals_won", "day").length, 1, "the win must not be in two places");
  assert.equal(
    bucketsFor("deals_won", "day")[0].bucketStart.getTime(),
    wonDay.getTime(),
    "a deal belongs to the day it was WON, not the day it was last touched",
  );
  assert.equal(totalCount("deals_won", "day"), 1);
});

test("no metric is bucketed by the change clock — not one of the four", async () => {
  // THE STRUCTURAL FORM OF THE RULE ABOVE, checked on the queries the rollup
  // actually emits rather than on one metric's behaviour.
  //
  // The test above proves `deals_won` is safe. This proves nothing else quietly
  // is not: `updatedAt` is the CHANGE CLOCK — the thing the probe watches to
  // decide "look again" — and the moment any metric also files rows BY it, that
  // metric double counts across every seal, for the most ordinary edit there is.
  // Adding a fifth metric is the likely way that comes back, and a fifth metric
  // will be written by copying one of these four.
  spy.reset({
    Lead: [
      lead({ id: "won", createdAt: ago(40), wonAt: ago(20), status: "won", valueCents: 10_000, assignedToId: "u1" }),
      lead({ id: "lost", createdAt: ago(40), lostAt: ago(20), status: "lost", valueCents: 20_000 }),
      lead({ id: "open", createdAt: ago(5) }),
    ],
    JobCard: [
      { id: "j", tenantId: TENANT, status: "collected", createdAt: ago(9), updatedAt: ago(4), completedAt: ago(4), deletedAt: null },
    ],
  });
  await stats.rollUpStatistics(NOW);

  const aggregates = spy.calls.filter((call) => call.model === "$queryRaw");
  assert.ok(aggregates.length > 0, "the rollup must have aggregated something");
  const bucketedOn = new Set<string>();
  for (const call of aggregates) {
    const text = call.args.text as string;
    // Two query shapes carry a bucket date: the aggregate ranges on it, and the
    // backfill's floor probe takes its MIN. Both must name the same immutable
    // column, and a query that names neither is a shape this guard has not been
    // taught — which is a reason to fail, not to pass.
    const column =
      text.match(/AND "(\w+)" >= \?/)?.[1] ?? text.match(/SELECT MIN\("(\w+)"\)/)?.[1];
    assert.ok(column, `an aggregate with no identifiable bucket date column:\n${text}`);
    assert.notEqual(
      column,
      "updatedAt",
      "a metric bucketed by the change clock double counts across every sealed period",
    );
    bucketedOn.add(column);
  }
  assert.deepEqual(
    [...bucketedOn].sort(),
    ["completedAt", "createdAt", "lostAt", "wonAt"],
    "each of the four metrics must range on its own immutable lifecycle date",
  );
});

test("a deal re-won after its first win sealed is counted in both — the known residual", async () => {
  // PINNING WHAT SEALING DOES NOT FIX, so it stays a bounded property rather
  // than becoming a discovery.
  //
  // Migration 52's trigger CLEARS `wonAt` when a deal is re-opened, so a deal
  // won in one sealed period and won AGAIN in an open one is counted in both.
  // That is deliberate and it is not the bug this feature was blocked on: the
  // trigger there was `updatedAt`, so ANY write by anyone — a note, an assignee
  // change, a bulk re-import — restated history and the totals drifted upward
  // continuously. The trigger here is a human deliberately un-winning and
  // re-winning a deal, which is a second commercial event, and a sealed period
  // reporting what was true of it at the time is what closing the books means.
  //
  // If this test ever fails it means the seal boundary moved. Read the note above
  // METRICS in statistics.ts before changing the number.
  spy.reset({
    Lead: [lead({ id: "w", createdAt: ago(140), wonAt: ago(100), status: "won", valueCents: 40_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);
  const sealedDay = time.startOfSastDay(ago(100));
  assert.equal(totalCount("deals_won", "day"), 1, "won once, counted once");

  // Re-opened (the trigger clears both dates), then won again today.
  const deal = spy.rows("Lead").find((row) => row.id === "w")!;
  deal.status = "won";
  deal.wonAt = NOW;
  deal.lostAt = null;
  deal.updatedAt = NOW;
  await stats.rollUpStatistics(NOW);

  assert.equal(
    bucketsFor("deals_won", "day").find((row) => row.bucketStart.getTime() === sealedDay.getTime())?.count,
    1,
    "the sealed period still reports what was true of it",
  );
  assert.equal(
    bucketsFor("deals_won", "day").find(
      (row) => row.bucketStart.getTime() === time.startOfSastDay(NOW).getTime(),
    )?.count,
    1,
    "and the new win lands in the period it happened in",
  );
  assert.equal(totalCount("deals_won", "day"), 2, "two wins of one deal — the bounded residual");
});

test("a deal reopened after it was won leaves the win series entirely", async () => {
  // The other half of "recompute, never increment": a row can still ENTER a
  // metric or LEAVE it while its bucket is open. Migration 52's trigger clears
  // both lifecycle dates when a deal goes back to `open`, so the bucket has
  // nothing left to count and must be deleted rather than left on the chart.
  spy.reset({
    Lead: [lead({ id: "w", createdAt: ago(9), wonAt: ago(3), status: "won", valueCents: 60_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);
  assert.equal(totalCount("deals_won", "day"), 1);

  const won = spy.rows("Lead").find((row) => row.id === "w")!;
  won.status = "open";
  won.wonAt = null;
  won.lostAt = null;
  won.updatedAt = NOW;
  await stats.rollUpStatistics(NOW);

  assert.equal(totalCount("deals_won", "day"), 0, "a reopened deal is not a win anywhere");
  assert.equal(totalCount("deals_won", "month"), 0);
});

test("month buckets are the sum of their day buckets", async () => {
  // The downsampling step. The coarse series is derived from the fine one
  // rather than recomputed from raw history — that is what makes keeping it
  // for years affordable — so it has to agree with it exactly.
  spy.reset({
    Lead: [
      lead({ id: "a", createdAt: ago(1), status: "won", valueCents: 10_000, assignedToId: "u1" }),
      lead({ id: "b", createdAt: ago(2), status: "won", valueCents: 20_000, assignedToId: "u1" }),
      lead({ id: "c", createdAt: ago(3), status: "won", valueCents: 30_000, assignedToId: "u1" }),
    ],
  });
  await stats.rollUpStatistics(NOW);

  // The second run takes the incremental path, which is the one that derives
  // months from days; the first backfilled both from source. Both must agree.
  spy.rows("Lead")[0].updatedAt = NOW;
  await stats.rollUpStatistics(NOW);

  const month = time.startOfSastMonth(NOW);
  const monthBucket = bucketsFor("deals_won", "month").find(
    (row) => row.bucketStart.getTime() === month.getTime(),
  );
  const dayTotal = bucketsFor("deals_won", "day")
    .filter((row) => time.startOfSastMonth(row.bucketStart).getTime() === month.getTime())
    .reduce((sum, row) => sum + row.count, 0);

  assert.equal(monthBucket?.count, dayTotal);
  assert.equal(monthBucket?.count, 3);
  assert.equal(Number(monthBucket?.sumCents), 60_000);
});

test("day buckets past the horizon are pruned and their month survives them", async () => {
  // Day buckets are bounded; month buckets are the long-term record and are why
  // day buckets CAN be bounded. Pruning the wrong one loses exactly the history
  // this feature exists to keep.
  //
  // The deal is older than the day horizon, so backfill gives it a MONTH bucket
  // and no day bucket; the day bucket is seeded by hand as the leftover a
  // long-running workspace would have. After the sweep the month must still be
  // there and the day must not.
  const age = stats.DAY_RETENTION_DAYS + 10;
  const ancientDay = time.startOfSastDay(ago(age));
  spy.reset({
    Lead: [lead({ id: "ancient", createdAt: ago(age), status: "won", valueCents: 5_000 })],
    statisticBucket: [
      storedBucket({
        metric: "deals_won",
        period: "day",
        bucketStart: ancientDay,
        count: 1,
        sumCents: 5_000,
      }),
    ],
  });

  const result = await stats.rollUpStatistics(NOW);

  assert.equal(result.bucketsPruned, 1);
  assert.equal(bucketsFor("deals_won", "day").length, 0, "the ancient day bucket is gone");
  const months = bucketsFor("deals_won", "month");
  assert.equal(months.length, 1, "its month is the long-term record and stays");
  assert.equal(months[0].bucketStart.getTime(), time.startOfSastMonth(ago(age)).getTime());
  assert.equal(Number(months[0].sumCents), 5_000, "…with the value intact");
});

test("day buckets outlive the point at which a month is sealed, by a wide margin", () => {
  // Months are DERIVED from days. If day buckets could be pruned before their
  // month stopped being recomputed, a month would be rebuilt from rows that no
  // longer exist and would silently lose part of itself. Read from the module
  // rather than trusted, because the relationship is what matters, not the
  // numbers.
  const monthSealPoint = stats.RECOMPUTE_WINDOW_DAYS + 31;
  assert.ok(
    stats.DAY_RETENTION_DAYS > monthSealPoint * 5,
    `day retention (${stats.DAY_RETENTION_DAYS}) must comfortably outlast the month seal point (${monthSealPoint})`,
  );
  // …and still cover a two-year daily comparison.
  assert.ok(stats.DAY_RETENTION_DAYS >= 731, "this year vs last year must not fall off the table");
});

/* ══════════════════════════════════════════════════════════════════════════
   THE CURSOR INVARIANT — it never advances past work that was not done
   ══════════════════════════════════════════════════════════════════════════ */

test("hitting the update ceiling revokes completion, and the cursor stays where it was", async () => {
  // A BOUNDED STEP THAT LIES ABOUT FINISHING IS WORSE THAN AN UNBOUNDED ONE.
  //
  // The ceiling exists so one tick cannot spend itself issuing updates. But a
  // truncated pass that then advances the cursor has thrown the remaining
  // corrections away permanently: the probe next tick asks "anything newer than
  // the cursor?", the answer is no, and the buckets past the cut-off keep values
  // nothing will ever revisit. Not slow — silently, permanently wrong, with the
  // rollup reporting success every time.
  //
  // The fixture builds one more changed bucket than the ceiling allows, so
  // exactly one correction is left over. Where that one ends up is the test.
  const ceiling = stats.MAX_BUCKET_UPDATES_PER_SWEEP;
  const channels = Array.from({ length: 20 }, (_, index) => `channel-${index}`);
  const leads: spy.Row[] = [];
  const wrongBuckets: spy.Row[] = [];
  let made = 0;
  for (let daysAgo = 1; daysAgo <= 30 && made <= ceiling; daysAgo++) {
    for (const channel of channels) {
      if (made > ceiling) break;
      const at = ago(daysAgo, 5);
      leads.push(lead({ id: `l${made}`, createdAt: at, source: channel, valueCents: 100 }));
      // Every one of these disagrees with source, so every one needs an update.
      wrongBuckets.push(storedBucket({
        metric: "leads_created",
        period: "day",
        bucketStart: time.startOfSastDay(at),
        dimension: channel,
        count: 99,
        sumCents: 99,
      }));
      made++;
    }
  }
  assert.equal(made, ceiling + 1, "the fixture must exceed the ceiling by exactly one");

  const staleCursorAt = ago(60);
  spy.reset({
    Lead: leads,
    statisticBucket: wrongBuckets,
    statisticCursor: [builtCursor("lead", staleCursorAt, "")],
  });

  const first = await stats.rollUpStatistics(NOW);
  assert.equal(first.complete, false, "a truncated pass must SAY it was truncated");
  assert.equal(
    cursorFor("lead")?.cursorAt.getTime(),
    staleCursorAt.getTime(),
    "the cursor must not move past corrections that were never applied",
  );
  const stillWrong = spy.rows("statisticBucket").filter((row) => row.count === 99);
  assert.equal(stillWrong.length, 1, "exactly one correction should be left over");

  // The next tick still sees the source as changed — because the cursor is still
  // behind it — and finishes the job.
  const second = await stats.rollUpStatistics(NOW);
  assert.equal(second.complete, true);
  assert.equal(
    spy.rows("statisticBucket").filter((row) => row.count === 99).length,
    0,
    "the leftover correction must be applied by a later tick, not lost",
  );
  assert.ok(
    (cursorFor("lead")?.cursorAt.getTime() ?? 0) > staleCursorAt.getTime(),
    "…and only THEN may the cursor advance",
  );
});

test("a truncated day pass does not get downsampled into a month that was never true", async () => {
  // Months are DERIVED from day buckets. Summing a day series that is half
  // corrected and half stale produces a month total that was true of no moment
  // in the workspace's history — and unlike a stale day bucket it does not even
  // match the source it came from. The month pass is therefore skipped outright
  // when the day pass came back incomplete.
  const ceiling = stats.MAX_BUCKET_UPDATES_PER_SWEEP;
  const channels = Array.from({ length: 20 }, (_, index) => `channel-${index}`);
  const leads: spy.Row[] = [];
  const wrongBuckets: spy.Row[] = [];
  let made = 0;
  for (let daysAgo = 1; daysAgo <= 30 && made <= ceiling; daysAgo++) {
    for (const channel of channels) {
      if (made > ceiling) break;
      const at = ago(daysAgo, 5);
      leads.push(lead({ id: `l${made}`, createdAt: at, source: channel, valueCents: 100 }));
      wrongBuckets.push(storedBucket({
        metric: "leads_created",
        period: "day",
        bucketStart: time.startOfSastDay(at),
        dimension: channel,
        count: 99,
        sumCents: 99,
      }));
      made++;
    }
  }
  spy.reset({
    Lead: leads,
    statisticBucket: wrongBuckets,
    statisticCursor: [builtCursor("lead", ago(60), "")],
  });

  const first = await stats.rollUpStatistics(NOW);
  assert.equal(first.complete, false);
  assert.equal(
    bucketsFor("leads_created", "month").length,
    0,
    "no month may be derived from a day series that is only half applied",
  );

  await stats.rollUpStatistics(NOW);
  const monthTotal = totalCount("leads_created", "month");
  const dayTotal = totalCount("leads_created", "day");
  assert.equal(monthTotal, dayTotal, "once the days are settled, the months agree with them exactly");
  assert.equal(dayTotal, made);
});

test("a backfill cut short by the tick budget resumes instead of starting again", async () => {
  // On a database too large to walk inside one 60-second tick, a backfill that
  // records nothing until it is wholly finished restarts from today on every
  // tick and never produces a usable history at all — non-terminating, not
  // merely slow. The progress marker is what makes the walk resumable, and the
  // absent `backfilledAt` is what stops a half-built history being served.
  spy.reset({
    Lead: [
      lead({ id: "recent", createdAt: ago(200), wonAt: ago(2), status: "won", valueCents: 10_000, assignedToId: "u1" }),
      lead({ id: "old", createdAt: ago(900), wonAt: ago(900), status: "won", valueCents: 20_000, assignedToId: "u1" }),
      lead({ id: "ancient", createdAt: ago(1400), wonAt: ago(1400), status: "won", valueCents: 30_000, assignedToId: "u1" }),
    ],
  });

  // Budget for exactly one slice, then "stop" for the rest of the tick.
  let slicesAllowed = 1;
  const first = await stats.rollUpStatistics(NOW, { shouldStop: () => slicesAllowed-- <= 0 });

  assert.equal(first.complete, false, "an unfinished walk must say so");
  assert.equal(first.backfillPending, 1, "…and must be reported as still pending");
  const parked = cursorFor("lead")!;
  assert.ok(parked.backfillFrom, "progress must be durable, or the next tick starts from today again");
  assert.equal(parked.backfilledAt ?? null, null, "a half-built history is not a built one");
  assert.equal(
    await stats.statisticsReadyFor(["deals_won"]),
    false,
    "and no reader may be served from it — a flat zero line reads as a collapsed business",
  );

  // THE POSITION THE WALK STARTED FROM, captured before any of it ran.
  const startPosition = parked.cursorAt.getTime();

  // Between ticks, somebody corrects a recent deal — one whose slice the FIRST
  // tick already aggregated, at the old value.
  const recent = spy.rows("Lead").find((row) => row.id === "recent")!;
  recent.valueCents = 999_000;
  recent.updatedAt = NOW;

  const second = await stats.rollUpStatistics(NOW);
  const built = cursorFor("lead")!;
  assert.ok(built.backfilledAt, "the walk must finish");
  assert.equal(second.backfilled, 1);
  assert.equal(built.backfillFrom ?? null, null, "the resume marker is cleared once it is meaningless");
  assert.equal(
    built.cursorAt.getTime(),
    startPosition,
    "the cursor records where the WALK BEGAN — an edit made while it ran is still ahead of it",
  );

  // …which is exactly what lets the next tick see and apply that correction.
  const third = await stats.rollUpStatistics(NOW);
  assert.equal(third.recomputed, 1, "the mid-backfill edit must still be visible to the probe");
  assert.equal(
    bucketsFor("deals_won", "day").find(
      (row) => row.bucketStart.getTime() === time.startOfSastDay(ago(2)).getTime(),
    )?.sumCents,
    BigInt(999_000),
    "and must actually be applied, rather than stepped over and lost",
  );
});

test("a backfill longer than one tick's slice budget resumes without a stop signal", async () => {
  // THE SAME INVARIANT ON THE OTHER BOUNDED STEP. The test above stops the walk
  // with `shouldStop` — the route's deadline. This one never stops it: the walk
  // simply has more history than MAX_BACKFILL_SLICES_PER_TICK covers, which is
  // the case on any workspace with a long enough past and no slow tick at all.
  //
  // Both ceilings have to revoke completion, not just the one that has a signal
  // attached. A slice budget that ran out and reported success would stamp
  // `backfilledAt` on a history that stops several years short, and NOTHING
  // rebuilds it afterwards — the incremental pass only ever looks inside the
  // 35-day window, so the missing years are missing permanently while the page
  // reports itself ready and draws them as zero.
  const reach = stats.MAX_BACKFILL_SLICES_PER_TICK * stats.BACKFILL_SLICE_MONTHS;
  // Comfortably older than one tick can walk, in days, without depending on how
  // many days those months happen to have.
  const ancient = Math.ceil((reach + 18) * 31);
  spy.reset({
    Lead: [
      lead({ id: "recent", createdAt: ago(3), wonAt: ago(3), status: "won", valueCents: 10_000, assignedToId: "u1" }),
      lead({ id: "ancient", createdAt: ago(ancient), wonAt: ago(ancient), status: "won", valueCents: 30_000, assignedToId: "u1" }),
    ],
  });

  const first = await stats.rollUpStatistics(NOW);
  assert.equal(first.complete, false, "a walk that ran out of slices has not finished");
  assert.equal(first.backfillPending, 1);
  const parked = cursorFor("lead")!;
  assert.equal(parked.backfilledAt ?? null, null, "…so it must not claim a built history");
  assert.ok(parked.backfillFrom, "…and must have recorded how far it got");
  assert.equal(await stats.statisticsReadyFor(["deals_won"]), false, "no reader may be served yet");
  const startPosition = parked.cursorAt.getTime();

  // Somebody corrects a recent deal between the two ticks — one the FIRST tick
  // already aggregated, at its old value. This is what makes the assertion below
  // about the START position mean something: without an edit in flight, the walk's
  // beginning and its end are the same row and either would pass.
  const recent = spy.rows("Lead").find((row) => row.id === "recent")!;
  recent.valueCents = 999_000;
  recent.updatedAt = NOW;

  // No stop signal on either tick — only the slice budget was ever in play.
  const second = await stats.rollUpStatistics(NOW);
  assert.equal(second.backfilled, 1, "the next tick carries on from the recorded position");
  const built = cursorFor("lead")!;
  assert.ok(built.backfilledAt);
  assert.equal(built.backfillFrom ?? null, null);
  assert.equal(
    built.cursorAt.getTime(),
    startPosition,
    "and still records where the WALK began, not where the finishing tick found itself",
  );

  // …which is the only reason the mid-walk correction is still ahead of the
  // cursor and gets applied at all.
  const third = await stats.rollUpStatistics(NOW);
  assert.equal(third.recomputed, 1, "the edit made while the walk ran must still be visible");
  assert.equal(
    bucketsFor("deals_won", "day").find(
      (row) => row.bucketStart.getTime() === time.startOfSastDay(ago(3)).getTime(),
    )?.sumCents,
    BigInt(999_000),
    "and applied, rather than stepped over by a cursor that jumped to the finishing tick",
  );

  // The oldest month is the point of the whole exercise: it is the rung of the
  // ladder that is kept for ever, and it is the one a truncated walk drops.
  assert.equal(
    bucketsFor("deals_won", "month").find(
      (row) => row.bucketStart.getTime() === time.startOfSastMonth(ago(ancient)).getTime(),
    )?.count,
    1,
    "the far end of history must actually be built, not merely declared built",
  );
});

test("a backfill that finishes in one tick still records the position it started from", async () => {
  // The same rule where there is no resumption to lean on. `newestSourceRow` is
  // read BEFORE the aggregates run, so a row written while they are running is
  // still beyond the cursor next tick — at worst counted twice, which is free
  // because a recompute derives the whole bucket rather than adding to it.
  spy.reset({
    Lead: [lead({ id: "a", createdAt: ago(3), wonAt: ago(3), status: "won", valueCents: 10_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);
  assert.equal(
    cursorFor("lead")?.cursorAt.getTime(),
    ago(3).getTime(),
    "the cursor is the newest row as it stood when the tick began",
  );
  assert.equal(cursorFor("lead")?.cursorId, "a");
});

/* ══════════════════════════════════════════════════════════════════════════
   TENANT SAFETY — the predicate is never implicit
   ══════════════════════════════════════════════════════════════════════════ */

test("the aggregate names the tenant, so two workspaces' numbers cannot merge", async () => {
  // The worst possible bug in a reporting feature, and the quietest: `$queryRaw`
  // and `basePrisma` both bypass the tenant extension, so the predicate it
  // would have added has to be written out by hand. Without it there is no
  // error and no foreign record on screen — just two businesses' deals summed
  // into one number.
  //
  // The tenant comes in as an OPTION here, which is the cron's real path
  // (runCronPerTenant already knows which slice it is running). It is resolved
  // once and threaded through every query rather than re-derived deeper down.
  spy.reset({
    Lead: [
      lead({ id: "mine", createdAt: ago(1), status: "won", valueCents: 10_000, assignedToId: "u1", tenantId: "t1" }),
      lead({ id: "theirs", createdAt: ago(1), status: "won", valueCents: 999_000, assignedToId: "u1", tenantId: "t2" }),
      lead({ id: "unowned", createdAt: ago(1), status: "won", valueCents: 777_000, assignedToId: "u1", tenantId: null }),
    ],
  });

  await stats.rollUpStatistics(NOW, { tenantId: "t1" });

  const aggregates = spy.calls.filter((call) => call.model === "$queryRaw");
  assert.ok(aggregates.length > 0, "the rollup must have aggregated something");
  for (const call of aggregates) {
    // STRICT equality for a non-founding tenant. `IS NOT DISTINCT FROM` — which
    // matches NULL against NULL — would let a second workspace absorb every
    // legacy un-owned row in the database, which in production today is most of
    // them.
    assert.match(
      call.args.text as string,
      /AND "tenantId" = \?::text/,
      "every aggregate must carry an explicit, strict tenant predicate",
    );
    // NAMED BY COLUMN, deliberately. `"deletedAt" IS NULL` is in every one of
    // these queries and has to be — without it a trashed lead counts for ever —
    // so a bare /IS NULL/ here looks stricter and is simply wrong: it fails on
    // the soft-delete filter the aggregate cannot do without, and says the
    // tenant predicate is the problem.
    assert.ok(
      !/"tenantId" IS NULL/.test(call.args.text as string),
      "a non-founding tenant must never be handed the un-owned rows",
    );
    assert.ok(
      (call.args.values as unknown[]).includes("t1"),
      "…bound to the tenant actually being rolled up",
    );
  }

  const won = bucketsFor("deals_won", "day");
  assert.equal(
    won.reduce((sum, row) => sum + Number(row.sumCents), 0),
    10_000,
    "neither t2's deal nor the un-owned one may appear",
  );
  assert.ok(
    spy.rows("statisticBucket").every((row) => row.tenantId === "t1"),
    "and every bucket written must be stamped with the writing tenant",
  );
});

test("an un-owned source row belongs to NOBODY — the founding tenant included", async () => {
  // THIS ASSERTION USED TO RUN THE OTHER WAY. The founding tenant's predicate was
  // `("tenantId" = $1 OR "tenantId" IS NULL)`, on the reasoning that enforcement
  // is dormant, the db.ts guard stamps nothing, and a bare `= $1` would report a
  // live business as having zero of everything.
  //
  // That premise expired. Both source tables were backfilled unconditionally —
  // Lead by 20260722120000_tenant_people_isolation, JobCard by
  // 20260722142000_tenant_workshop_isolation — so every row predating tenancy is
  // already owned, and a NULL row TODAY was written AFTER its backfill by a live
  // code path. It is not "old", it is "owned by an unknown workspace", which in a
  // two-tenant world may be t2's. The read-only production audit of 2026-08-10
  // (PREFLIP-TENANT-AUDIT.md §1) lists every table holding an un-owned row and
  // neither Lead nor JobCard is among them: nothing is stranded by refusing it.
  //
  // The direction is what makes this the safe answer. Excluding an un-owned row
  // understates one workspace's numbers and is recoverable the moment the row is
  // stamped; including it folds an unknown workspace's revenue into the founding
  // tenant's reports, which no later correction can detect.
  spy.reset({
    Lead: [
      lead({ id: "mine", createdAt: ago(1), status: "won", valueCents: 12_000, assignedToId: "u1" }),
      lead({ id: "unowned", createdAt: ago(1), status: "won", valueCents: 500_000, assignedToId: "u1", tenantId: null }),
      lead({ id: "theirs", createdAt: ago(1), status: "won", valueCents: 999_000, assignedToId: "u1", tenantId: "t2" }),
    ],
  });

  await stats.rollUpStatistics(NOW);

  for (const call of spy.calls.filter((call) => call.model === "$queryRaw")) {
    const text = call.args.text as string;
    assert.match(
      text,
      /AND "tenantId" = \?::text/,
      "the founding tenant takes the same strict predicate as everyone else",
    );
    // NAMED BY COLUMN, deliberately: `"deletedAt" IS NULL` is in every one of
    // these queries and has to be, so a bare /IS NULL/ here would fail on the
    // soft-delete filter and blame the tenant predicate.
    assert.ok(
      !/"tenantId" IS NULL/.test(text),
      `no tenant, founding included, may be handed the un-owned rows:\n${text}`,
    );
  }
  assert.equal(
    bucketsFor("deals_won", "day").reduce((sum, row) => sum + Number(row.sumCents), 0),
    12_000,
    "only the founding tenant's own deal counts — not the un-owned one, not t2's",
  );
});

test("a bucket is never written without a tenant, even while enforcement is dormant", async () => {
  // A NULL-tenant bucket is not a cosmetic gap. The table's RLS policy has no
  // `IS NULL` escape hatch, so such a row becomes INVISIBLE the moment strict
  // enforcement is switched on — a workspace's entire reporting history orphaned
  // at the exact moment isolation starts mattering, and a cursor orphaned that
  // way is worse still: the rollup decides the tenant was never backfilled and
  // rebuilds everything from scratch.
  spy.reset({
    Lead: [lead({ id: "a", createdAt: ago(2), status: "won", valueCents: 1_000, assignedToId: "u1" })],
    JobCard: [{ id: "j", tenantId: TENANT, status: "done", createdAt: ago(2), updatedAt: ago(2), completedAt: ago(2), deletedAt: null }],
  });
  await stats.rollUpStatistics(NOW);

  assert.ok(spy.rows("statisticBucket").length > 0, "there must be something to check");
  for (const row of [...spy.rows("statisticBucket"), ...spy.rows("statisticCursor")]) {
    assert.equal(typeof row.tenantId, "string", "tenantId must be present on every row written");
    assert.ok((row.tenantId as string).length > 0, "…and must not be blank");
    assert.equal(row.tenantId, TENANT, "…resolved from the SCOPE, not left null while dormant");
  }

  // The Prisma model has to agree, or the next `prisma migrate dev` re-widens it.
  const schema = src("prisma/statistics.prisma");
  assert.match(schema, /model StatisticBucket \{[\s\S]*?\n\s*tenantId\s+String\s*\n/, "StatisticBucket.tenantId must be non-nullable");
  assert.match(schema, /model StatisticCursor \{[\s\S]*?\n\s*tenantId\s+String\s*\n/, "StatisticCursor.tenantId must be non-nullable");
  assert.ok(
    !/tenantId\s+String\?/.test(schema),
    "a nullable tenantId is the whole defect — it must not come back",
  );
});

test("every bucket and cursor statement states its tenant, rather than leaning on the guard", async () => {
  // The db.ts guard adds NO predicate while enforcement is dormant, which is
  // every deployment today, so `where: { id }` alone is not tenant-scoped — it
  // is unscoped with a comforting shape. The ids happen to embed the tenant,
  // which is a reason this is SAFE, not a reason to leave the predicate out: the
  // day someone writes a query that does not build its id that way, the
  // predicate is the only thing left.
  spy.reset({
    Lead: [
      lead({ id: "a", createdAt: ago(2), status: "won", valueCents: 1_000, assignedToId: "u1" }),
      lead({ id: "b", createdAt: ago(400), status: "lost", valueCents: 2_000 }),
    ],
    statisticBucket: [
      storedBucket({ metric: "deals_won", period: "day", bucketStart: time.startOfSastDay(ago(2)), dimension: "u1", count: 99, sumCents: 99 }),
      storedBucket({ metric: "leads_created", period: "day", bucketStart: time.startOfSastDay(ago(600)), dimension: "website", count: 1, sumCents: 1 }),
    ],
  });
  await stats.rollUpStatistics(NOW);

  const statementsOnStatisticTables = spy.calls.filter((call) => call.model.startsWith("statistic"));
  assert.ok(statementsOnStatisticTables.length > 0);
  for (const call of statementsOnStatisticTables) {
    if (call.op === "createMany") {
      const data = Array.isArray(call.args.data) ? call.args.data : [call.args.data];
      for (const row of data) {
        assert.equal(row.tenantId, TENANT, `${call.model}.createMany wrote a row with no tenant`);
      }
      continue;
    }
    if (call.op === "upsert") {
      assert.equal(call.args.create.tenantId, TENANT, `${call.model}.upsert can create a tenantless row`);
      continue;
    }
    assert.equal(
      call.args.where?.tenantId,
      TENANT,
      `${call.model}.${call.op} does not name the tenant it is addressing`,
    );
  }
});

test("under enforcement the tenant comes from the scope, and a scopeless rollup refuses to run", async () => {
  // The dormant path falls back to the founding tenant; the ENFORCING path must
  // not. A rollup that ran unscoped under enforcement would aggregate across
  // every workspace and stamp the result with whichever tenant it guessed, so
  // `writeTenantId()` throws instead — the same fail-closed idiom as every other
  // unguarded write path in the app.
  enforcement.__setTenantEnforcingForTests(true);
  try {
    spy.reset({
      Lead: [
        lead({ id: "mine", createdAt: ago(1), status: "won", valueCents: 10_000, assignedToId: "u1", tenantId: "t9" }),
        lead({ id: "theirs", createdAt: ago(1), status: "won", valueCents: 999_000, assignedToId: "u1", tenantId: "t8" }),
      ],
    });

    await scope.runInTenantScope({ tenantId: "t9", system: false }, () =>
      stats.rollUpStatistics(NOW),
    );
    assert.ok(
      spy.rows("statisticBucket").every((row) => row.tenantId === "t9"),
      "the scope's tenant must be the one written",
    );
    assert.equal(
      bucketsFor("deals_won", "day").reduce((sum, row) => sum + Number(row.sumCents), 0),
      10_000,
    );

    await assert.rejects(
      () => stats.rollUpStatistics(NOW),
      /tenant scope/i,
      "enforcing with no scope must fail closed, not fall back to everyone's data",
    );
  } finally {
    enforcement.__setTenantEnforcingForTests(null);
  }
});

test("only the metrics the app already reports are recorded", () => {
  // Not a catalogue. Every metric here is a number the Reports page computes
  // today; the guard exists so a fifth is a deliberate decision rather than
  // something that accretes.
  assert.deepEqual(
    [...stats.STATISTIC_METRICS],
    ["leads_created", "deals_won", "deals_lost", "jobcards_completed"],
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE READS
   ══════════════════════════════════════════════════════════════════════════ */

test("folding buckets onto an axis fills the gaps rather than shifting the series", () => {
  // A day with no leads has no bucket ROW — storing zeroes for every quiet day
  // of every metric would be most of the table. So the axis, not the data,
  // decides how many points a chart has; a fold that skipped missing buckets
  // would slide every later bar one place to the left.
  const axis = time.periodStarts("day", ago(3), NOW);
  const rows = [
    { bucketStart: axis[0], dimension: "", count: 2, sumCents: 500 },
    { bucketStart: axis[2], dimension: "", count: 5, sumCents: 100 },
  ];
  assert.deepEqual(
    stats.seriesOf(rows, axis).map((point) => point.count),
    [2, 0, 5, 0],
  );
  assert.deepEqual(stats.totalOf(rows), { count: 7, sumCents: 600 });
});

test("a breakdown folds every dimension of a bucket, not just the first", () => {
  const day = time.startOfSastDay(ago(1));
  const rows = [
    { bucketStart: day, dimension: "u1", count: 1, sumCents: 100 },
    { bucketStart: day, dimension: "u2", count: 2, sumCents: 200 },
    { bucketStart: time.startOfSastDay(ago(2)), dimension: "u1", count: 4, sumCents: 400 },
  ];
  const breakdown = stats.breakdownOf(rows);
  assert.deepEqual(breakdown.get("u1"), { count: 5, sumCents: 500 });
  assert.deepEqual(breakdown.get("u2"), { count: 2, sumCents: 200 });
});

test("an unbuilt bucket table is never read as if it were zero", async () => {
  // Between the deploy and the first cron tick there is nothing in the table. A
  // page that read it anyway would draw a flat zero line, which does not look
  // like a cold start — it looks like the business collapsed.
  spy.reset({ Lead: [lead({ id: "l1", createdAt: ago(1) })] });
  assert.equal(await stats.statisticsReadyFor(["deals_won"]), false);

  await stats.rollUpStatistics(NOW);
  assert.equal(await stats.statisticsReadyFor(["deals_won"]), true);
  assert.equal(
    await stats.statisticsReadyFor(["deals_won", "jobcards_completed"]),
    true,
    "both sources are backfilled together on a cold start",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE PAGE
   ══════════════════════════════════════════════════════════════════════════ */

test("a restricted or filtered reader is never served from the buckets", () => {
  // Buckets are a whole-tenant aggregate with no per-record permissions in
  // them, and they cannot be re-filtered by an arbitrary list of permitted ids
  // after the fact. Serving a restricted reader from them shows them other
  // people's numbers — a worse failure than a slow page, and an invisible one.
  const page = shipped("src/app/(app)/reports/page.tsx");
  assert.match(
    page,
    /const useBuckets =\s*\n?\s*unrestricted && !filtered && \(await statisticsReadyFor\(neededMetrics, statsTenantId\)\)/,
    "the fast path must require BOTH full visibility and no filters, plus built buckets",
  );
  // The live path must still exist and still be reachable.
  assert.match(page, /: await liveAggregates\(\{/, "the live fallback must remain wired up");
});

test("both paths date a won deal the same way, or the two disagree for different readers", () => {
  // The bucket path serves unrestricted, unfiltered readers; the live path
  // serves everybody else. If the live path kept dating a win by `updatedAt`,
  // the same month would show different numbers to a manager and to a rep, and
  // adding a note to an old deal would move it into the current month for one of
  // them and not the other. Whichever number is right, they cannot both be.
  const page = shipped("src/app/(app)/reports/page.tsx");
  assert.match(page, /status: "won", wonAt: \{ gte:/, "the live win query must range on wonAt");
  assert.match(page, /status: "lost", lostAt: \{ gte:/, "…and the loss query on lostAt");
  assert.ok(
    !/status: "won", updatedAt:/.test(page) && !/status: "lost", updatedAt:/.test(page),
    "a closed deal must never be dated by the column that moves when someone types",
  );
  // The page resolves ONE tenant and hands it to the readiness check and every
  // read, so it cannot decide it is ready on one workspace and read another's.
  assert.match(page, /const statsTenantId = statisticsTenantId\(\)/);
  assert.match(page, /readStatisticBuckets\(\{ metric, period, from: rangeFrom, to: rangeTo, tenantId \}\)/);
});

test("the immutable lifecycle dates the buckets key on are visible to Prisma", () => {
  // `wonAt`/`lostAt` have existed on the "Lead" TABLE since migration 52 but
  // were in no Prisma model, which is the whole reason every reporting surface
  // fell back to `updatedAt`. The raw aggregate could always read them; the live
  // path could not, so leaving them unmodelled would have left half the feature
  // dating deals by the wrong column.
  const schema = src("prisma/schema.prisma");
  assert.match(schema, /\n\s*wonAt\s+DateTime\?/, "Lead.wonAt must be modelled");
  assert.match(schema, /\n\s*lostAt\s+DateTime\?/, "Lead.lostAt must be modelled");
});

test("both paths bucket on the same axis, so switching cannot move a bar", () => {
  const page = shipped("src/app/(app)/reports/page.tsx");
  assert.ok(
    !/30\.44/.test(page),
    "the fractional-month step is gone — those bars were not months",
  );
  const axis = page.indexOf("const axis = periodStarts(period, from, to)");
  assert.notEqual(axis, -1, "the shared axis is gone — was it renamed?");
  assert.ok(
    page.indexOf("spansFor(period, axis, to)") > axis,
    "the live path must build its spans FROM the shared axis, not its own",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SCHEMA
   ══════════════════════════════════════════════════════════════════════════ */

test("the queries the rollup runs every tick have indexes to use", () => {
  // Without these the "nothing new" probe is a sequential scan of the busiest
  // table in the CRM, once per tenant per tick, to find nothing — housekeeping
  // that costs more than the reporting it accelerates.
  const migration = src("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  const required: Array<[string, string]> = [
    ["Lead_tenantId_updatedAt_id_idx", '"Lead"("tenantId", "updatedAt", "id")'],
    ["Lead_tenantId_createdAt_idx", '"Lead"("tenantId", "createdAt")'],
    // The won/lost aggregates range on the IMMUTABLE lifecycle dates, and the
    // backfill walk asks each for its MIN. Unindexed, every won/lost recompute
    // is a sequential scan of the busiest table in the CRM.
    ["Lead_tenantId_wonAt_idx", '"Lead"("tenantId", "wonAt")'],
    ["Lead_tenantId_lostAt_idx", '"Lead"("tenantId", "lostAt")'],
    ["JobCard_tenantId_updatedAt_id_idx", '"JobCard"("tenantId", "updatedAt", "id")'],
    ["JobCard_tenantId_createdAt_idx", '"JobCard"("tenantId", "createdAt")'],
    ["JobCard_tenantId_completedAt_idx", '"JobCard"("tenantId", "completedAt")'],
    ["StatisticBucket_tenantId_metric_period_bucketStart_idx", '"StatisticBucket"("tenantId", "metric", "period", "bucketStart")'],
    ["StatisticBucket_tenantId_period_bucketStart_idx", '"StatisticBucket"("tenantId", "period", "bucketStart")'],
  ];
  for (const [name, columns] of required) {
    assert.ok(
      migration.includes(`CREATE INDEX IF NOT EXISTS "${name}"`) && migration.includes(columns),
      `missing index ${name} on ${columns}`,
    );
  }
  // tenantId LEADS every one of them. The rollup and the reads both name the
  // tenant explicitly, so without it the quietest workspace's early-out walks the
  // busiest workspace's history on every tick.
  for (const [, columns] of required) {
    assert.match(columns, /\("tenantId",/, `${columns} must lead with tenantId`);
  }
  // CONCURRENTLY cannot run inside Prisma's per-migration transaction: using it
  // here would not trade a lock for availability, it would fail the migration
  // and ship no index at all. Matched as a STATEMENT rather than as a word — the
  // migration names it in a comment and in the error it raises, and a guard that
  // reads the explanation as the offence fails on the file doing the right thing.
  assert.ok(
    !/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/im.test(migration),
    "CREATE INDEX CONCURRENTLY fails inside Prisma's migration transaction",
  );
});

test("the index builds are GATED on a busy table, not merely warned about", () => {
  // The original shipped a plain `CREATE INDEX` on "Lead" with a comment above
  // it. A comment does not stop a deploy: on the live database that statement
  // takes a SHARE lock and blocks every INSERT, UPDATE and DELETE on the busiest
  // table in the CRM for the whole build. So the check has to be executable and
  // it has to FAIL, and it has to say what to run instead.
  const migration = src("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  assert.match(migration, /RAISE EXCEPTION/, "the gate must fail the deploy, not log");
  assert.match(migration, /pg_table_size/, "…on a size threshold, so CI and fresh databases sail through");
  assert.match(migration, /to_regclass/, "…and only for indexes that are actually missing");
  assert.match(
    migration,
    /scripts\/prebuild-statistics-indexes\.sql/,
    "the failure must name the artifact that fixes it",
  );
  // A deliberate, explicit escape hatch — a maintenance window, a restore — so
  // the gate is a decision point rather than a wall someone routes around by
  // editing the migration.
  assert.match(migration, /app\.allow_blocking_index_build/);
});

test("the migration's backfills run with RLS bypassed, and hand the session back", () => {
  // "Lead" is FORCE ROW LEVEL SECURITY, which applies to the table owner — the
  // role migrations run as. Without the bypass the backfill matches ZERO rows
  // and reports success, so every deal closed before migration 52 keeps a NULL
  // lifecycle date and is silently absent from every won/lost number this
  // feature will ever report. Worse, the assertion written to catch that reads
  // the same empty table and passes. The one guard against a silently short
  // report would itself be silently vacuous.
  const migration = statements("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  const bypass = migration.indexOf("SET app.bypass_rls = 'on';");
  const reset = migration.indexOf("RESET app.bypass_rls;");
  assert.notEqual(bypass, -1, "a backfill over a FORCE RLS table needs the policy's escape hatch");
  assert.notEqual(reset, -1, "…and must not leave RLS disarmed for the migrations that follow");
  assert.ok(reset > bypass, "the reset must come last");
  for (const backfill of [
    'UPDATE "Lead" SET "wonAt"',
    'UPDATE "Lead" SET "lostAt"',
    'UPDATE "StatisticBucket" SET "tenantId"',
    'UPDATE "StatisticCursor" SET "tenantId"',
  ]) {
    const at = migration.indexOf(backfill);
    assert.notEqual(at, -1, `the ${backfill} backfill is gone — was it renamed?`);
    assert.ok(at > bypass && at < reset, `${backfill} runs outside the bypass and will match nothing`);
  }
});

test("the tenant column is added nullable, backfilled, then proved before it is narrowed", () => {
  // EXPAND/CONTRACT. `apply-migrations && next build` means the schema changes
  // while the PREVIOUS deployment is still serving, and the runner records a
  // migration only after its SQL succeeds — so a crash re-runs the whole file.
  // Adding the column already NOT NULL fails the moment one legacy row exists;
  // adding it NOT NULL DEFAULT '' succeeds and silently reassigns every existing
  // bucket to a tenant that does not exist. Nullable → backfill → SET NOT NULL
  // is the only order that is both safe and self-verifying: the SET NOT NULL
  // re-scans and fails the deploy if the backfill missed anything.
  const migration = statements("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  for (const table of ["StatisticBucket", "StatisticCursor"]) {
    const add = migration.indexOf(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;`);
    const fill = migration.indexOf(`UPDATE "${table}" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;`);
    const narrow = migration.indexOf(`ALTER TABLE "${table}" ALTER COLUMN "tenantId" SET NOT NULL;`);
    assert.ok(add !== -1 && fill !== -1 && narrow !== -1, `${table} is missing a step of the expand`);
    assert.ok(add < fill && fill < narrow, `${table} narrows its tenant column out of order`);
    // Re-runnable: the guard is the WHERE clause, which is already false the
    // second time round rather than being a flag that could be misread.
    assert.match(migration, new RegExp(`UPDATE "${table}"[^;]*WHERE "tenantId" IS NULL`));
    // And declared NOT NULL from the start on a database that never saw the
    // earlier draft, so the repair path is genuinely a no-op there.
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"[\\s\\S]*?"tenantId" TEXT NOT NULL`),
      `${table} must be created with a NOT NULL tenantId on a fresh database`,
    );
  }
  // The Lead backfill is guarded the same way, and only touches rows that
  // predate the trigger which now maintains these columns.
  assert.match(migration, /UPDATE "Lead" SET "wonAt" = "updatedAt" WHERE "status" = 'won' AND "wonAt" IS NULL;/);
  assert.match(migration, /UPDATE "Lead" SET "lostAt" = "updatedAt" WHERE "status" = 'lost' AND "lostAt" IS NULL;/);
});

test("the write-blocking index builds have a runnable concurrent path", () => {
  // A plain CREATE INDEX blocks writes on "Lead" for the whole build, and "Lead"
  // is the busiest table in the CRM. So the concurrent path has to be an
  // artifact someone can run, not a note in a comment — and the migration has
  // to name it, or nobody deploying will know it exists.
  const prebuild = src("scripts/prebuild-statistics-indexes.sql");
  const migration = src("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  for (const [name, columns] of [
    ["Lead_tenantId_updatedAt_id_idx", '"Lead"("tenantId", "updatedAt", "id")'],
    ["Lead_tenantId_createdAt_idx", '"Lead"("tenantId", "createdAt")'],
    ["Lead_tenantId_wonAt_idx", '"Lead"("tenantId", "wonAt")'],
    ["Lead_tenantId_lostAt_idx", '"Lead"("tenantId", "lostAt")'],
    ["JobCard_tenantId_updatedAt_id_idx", '"JobCard"("tenantId", "updatedAt", "id")'],
    ["JobCard_tenantId_createdAt_idx", '"JobCard"("tenantId", "createdAt")'],
    ["JobCard_tenantId_completedAt_idx", '"JobCard"("tenantId", "completedAt")'],
  ]) {
    assert.ok(
      prebuild.includes(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}"`) &&
        prebuild.includes(columns),
      `the prebuild script must cover ${name}, or that half of the deploy still locks`,
    );
  }
  assert.match(migration, /scripts\/prebuild-statistics-indexes\.sql/);
  // An interrupted CONCURRENTLY build leaves an INVALID index that Postgres does
  // not repair and the planner will not use — a silently unindexed table.
  assert.match(prebuild, /indisvalid/, "the script must say how to find a failed build");
});

test("the new tables have a row-level boundary like every other tenant table", () => {
  // FORCE RLS is live on every tenant table. A new one that skips it is the
  // single table in the schema with no row-level boundary — and it is a table
  // of AGGREGATES, where a leak is not a visible foreign record but two
  // workspaces' numbers quietly summed together.
  const migration = src("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  for (const table of ["StatisticBucket", "StatisticCursor"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(
      migration,
      new RegExp(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"`),
      `${table} has no isolation policy`,
    );
  }
});

test("bucket identity is a primary key over a derived id, with no null semantics to get wrong", () => {
  // The id is a pure function of (tenant, metric, period, bucketStart,
  // dimension), so two runs computing the same bucket address the same row and
  // the primary key is the duplicate guard. A UNIQUE over those five columns
  // instead would have depended on none of them ever being NULL — which is
  // exactly the assumption the nullable tenantId broke, because Postgres treats
  // NULLs in a unique index as distinct and would have permitted unlimited
  // duplicate buckets. Duplicates here are doubled numbers, silently.
  const migration = src("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  assert.match(migration, /CONSTRAINT "StatisticBucket_pkey" PRIMARY KEY \("id"\)/);
  assert.ok(
    !/CREATE UNIQUE INDEX[^;]*"StatisticBucket"/.test(migration),
    "bucket identity is the derived primary key, not a separate unique index",
  );
});

test("a migration touching a tenant column sorts AFTER the one that adds it", () => {
  // scripts/apply-migrations.mjs orders by `Number.parseInt(name, 10)`, NOT
  // lexicographically. So `81_foo` sorts as 81 and every timestamped migration
  // sorts as a 14-digit number — meaning EVERY timestamped migration runs after
  // EVERY numeric one. This migration indexes "Lead"("tenantId", …); a numeric
  // prefix would run it long before the tenant column exists.
  const dir = path.join(root, "prisma/migrations");
  const order = (name: string) => Number.parseInt(name, 10);
  const names = readdirSync(dir).filter((n) => existsSync(path.join(dir, n, "migration.sql")));
  const mine = "20260804120000_reporting_statistics";
  assert.ok(names.includes(mine), "the migration is gone — was it renamed?");

  const adder = names.find((n) =>
    /ALTER TABLE "Lead"\s+ADD COLUMN[^;]*"tenantId"/.test(
      readFileSync(path.join(dir, n, "migration.sql"), "utf8"),
    ),
  );
  assert.ok(adder, 'no migration adds "Lead"."tenantId" — has the schema been reorganised?');
  assert.ok(
    order(mine) > order(adder),
    `${mine} sorts before ${adder}, which is where "Lead"."tenantId" comes from`,
  );
});

test("the rollup is not wired into a queue that sends things", () => {
  // Reporting housekeeping sharing a budget with email and WhatsApp delivery
  // would be competing with sends for it — and losing that competition is the
  // right outcome every time, which is another way of saying it would rarely
  // run. Its own route gives it a budget nothing else wants.
  const route = shipped("src/app/api/cron/statistics/route.ts");
  assert.match(route, /isAuthorizedCron\(req\)/, "an unauthenticated rollup endpoint is a DoS lever");
  assert.match(route, /runCronPerTenant\(/, "the rollup must run once per tenant, in scope");
  assert.match(route, /budget\.shouldStop\(ROLLUP_RESERVE_MS\)/, "it must decline on a spent budget");
  assert.match(
    src("vercel.json"),
    /"path": "\/api\/cron\/statistics"/,
    "a cron route nothing schedules never runs",
  );
});
