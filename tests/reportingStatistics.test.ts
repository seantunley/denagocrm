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

const DAY = 24 * 60 * 60 * 1000;
/** 11:00 SAST on Tuesday 4 August 2026. Mid-morning, so no boundary is nearby. */
const NOW = new Date("2026-08-04T09:00:00.000Z");
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3600_000);

type LeadSeed = Partial<spy.SourceRow> & { id: string; createdAt: Date };
const lead = (seed: LeadSeed): spy.Row => ({
  status: "open",
  source: "website",
  assignedToId: null,
  valueCents: 0,
  deletedAt: null,
  tenantId: null,
  updatedAt: seed.createdAt,
  ...seed,
});

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
    stats.statisticBucketId(null, "deals_won", "day", new Date(0), ""),
    stats.statisticBucketId("t1", "deals_lost", "day", new Date(0), ""),
    stats.statisticBucketId("t1", "deals_won", "month", new Date(0), ""),
    stats.statisticBucketId("t1", "deals_won", "day", new Date(1), ""),
    stats.statisticBucketId("t1", "deals_won", "day", new Date(0), "x"),
  ]);
  assert.equal(ids.size, 7, "every component must be part of the identity");
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
      {
        id: stats.statisticBucketId(null, "deals_won", "day", day, "u1"),
        tenantId: null,
        metric: "deals_won",
        period: "day",
        bucketStart: day,
        dimension: "u1",
        count: 999,
        sumCents: BigInt(999_999),
        computedAt: ago(9),
      },
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
  // a trashed lead can only leave its bucket by being filtered out. Asserting
  // on `deals_won` would prove nothing: that metric buckets by `updatedAt`, and
  // the soft delete bumps `updatedAt`, so the row would move to today's bucket
  // and yesterday's count would drop by one whether or not the filter existed.
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

test("a sealed bucket keeps the number it was computed with", async () => {
  // THE SEAL POLICY, stated as behaviour. A bucket older than the recompute
  // window is never revisited, and the consequence is deliberate: the app dates
  // a won deal by `updatedAt`, so editing an old deal today moves it into
  // today's window. The LIVE query rewrites March's total when that happens —
  // history changes because someone typed a comment. The bucket does not.
  spy.reset({
    Lead: [lead({ id: "old", createdAt: ago(100), status: "won", valueCents: 40_000, assignedToId: "u1" })],
  });
  await stats.rollUpStatistics(NOW);

  const sealedDay = time.startOfSastDay(ago(100));
  const sealed = bucketsFor("deals_won", "day").find(
    (row) => row.bucketStart.getTime() === sealedDay.getTime(),
  );
  assert.equal(sealed?.count, 1, "backfill must have built the old bucket first");
  assert.ok(
    100 > stats.RECOMPUTE_WINDOW_DAYS,
    "the fixture must actually be outside the window, or this proves nothing",
  );

  // Someone edits the old deal today. Nothing about the deal's outcome changed.
  const old = spy.rows("Lead").find((row) => row.id === "old")!;
  old.updatedAt = NOW;
  await stats.rollUpStatistics(NOW);

  assert.equal(
    bucketsFor("deals_won", "day").find((row) => row.bucketStart.getTime() === sealedDay.getTime())?.count,
    1,
    "the sealed bucket must be untouched — that is what sealing means",
  );
  assert.equal(
    bucketsFor("deals_won", "day").find(
      (row) => row.bucketStart.getTime() === time.startOfSastDay(NOW).getTime(),
    )?.count,
    1,
    "and today's bucket reflects what the source now says, which is where the edit landed",
  );
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
      {
        id: stats.statisticBucketId(null, "deals_won", "day", ancientDay, ""),
        tenantId: null,
        metric: "deals_won",
        period: "day",
        bucketStart: ancientDay,
        dimension: "",
        count: 1,
        sumCents: BigInt(5_000),
        computedAt: ago(age),
      },
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

test("the aggregate names the tenant, so two workspaces' numbers cannot merge", async () => {
  // The worst possible bug in a reporting feature, and the quietest: `$queryRaw`
  // and `basePrisma` both bypass the tenant extension, so the predicate it
  // would have added has to be written out by hand. Without it there is no
  // error and no foreign record on screen — just two businesses' deals summed
  // into one number.
  spy.reset({
    Lead: [
      lead({ id: "mine", createdAt: ago(1), status: "won", valueCents: 10_000, assignedToId: "u1", tenantId: "t1" }),
      lead({ id: "theirs", createdAt: ago(1), status: "won", valueCents: 999_000, assignedToId: "u1", tenantId: "t2" }),
    ],
  });

  await scope.runInTenantScope({ tenantId: "t1", system: false }, () => stats.rollUpStatistics(NOW));

  const aggregates = spy.calls.filter((call) => call.model === "$queryRaw");
  assert.ok(aggregates.length > 0, "the rollup must have aggregated something");
  for (const call of aggregates) {
    assert.match(
      call.args.text as string,
      /AND "tenantId" IS NOT DISTINCT FROM \?::text/,
      "every aggregate must carry an explicit tenant predicate",
    );
    assert.ok(
      (call.args.values as unknown[]).includes("t1"),
      "…bound to the tenant actually in scope",
    );
  }

  const won = bucketsFor("deals_won", "day");
  assert.equal(won.reduce((sum, row) => sum + Number(row.sumCents), 0), 10_000, "t2's deal must not appear");
  assert.ok(
    spy.rows("statisticBucket").every((row) => row.tenantId === "t1"),
    "and every bucket written must be stamped with the writing tenant",
  );
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
    /const useBuckets =\s*\n?\s*unrestricted && !filtered && \(await statisticsReadyFor\(neededMetrics\)\)/,
    "the fast path must require BOTH full visibility and no filters, plus built buckets",
  );
  // The live path must still exist and still be reachable.
  assert.match(page, /: await liveAggregates\(\{/, "the live fallback must remain wired up");
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
    ["JobCard_tenantId_updatedAt_id_idx", '"JobCard"("tenantId", "updatedAt", "id")'],
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
  // tenantId LEADS every one of them. The rollup and the reads both run inside a
  // tenant scope, so without it the quietest workspace's early-out walks the
  // busiest workspace's history on every tick.
  for (const [, columns] of required) {
    assert.match(columns, /\("tenantId",/, `${columns} must lead with tenantId`);
  }
  // CONCURRENTLY cannot run inside Prisma's per-migration transaction: using it
  // here would not trade a lock for availability, it would fail the migration
  // and ship no index at all. Comments stripped first — the migration explains
  // at length why it is absent, and a guard that reads the explanation as the
  // offence fails on the file doing the right thing.
  assert.ok(
    !/CONCURRENTLY/.test(migration.replace(/^\s*--.*$/gm, "")),
    "CREATE INDEX CONCURRENTLY fails inside Prisma's migration transaction",
  );
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
    ["JobCard_tenantId_updatedAt_id_idx", '"JobCard"("tenantId", "updatedAt", "id")'],
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

test("bucket identity is a primary key, not a unique index over a nullable column", () => {
  // `tenantId` is nullable and IS null in enforcement-dormant mode, which is
  // every deployment today. Postgres treats NULLs in a unique index as
  // distinct, so a UNIQUE(tenantId, metric, period, bucketStart, dimension)
  // would permit unlimited duplicate buckets in exactly the mode that is
  // actually running — and duplicates here are doubled numbers, silently.
  const migration = src("prisma/migrations/20260804120000_reporting_statistics/migration.sql");
  assert.match(migration, /CONSTRAINT "StatisticBucket_pkey" PRIMARY KEY \("id"\)/);
  assert.ok(
    !/CREATE UNIQUE INDEX[^;]*"StatisticBucket"/.test(migration),
    "a unique index over the nullable tenantId cannot enforce bucket identity",
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
