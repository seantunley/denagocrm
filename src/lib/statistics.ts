import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import {
  statisticsScopeFor,
  statisticsScopeSql,
  statisticsScopeWhere,
} from "./statisticsTenantRule";
import {
  addPeriods,
  startOfPeriod,
  startOfSastDay,
  startOfSastMonth,
  type StatisticPeriod,
} from "./statisticsTime";

/**
 * Long-term reporting statistics.
 *
 * The Reports page answers "deals won per month, this year vs last" by
 * materialising a YEAR of Lead rows into Node — twice, once for the range and
 * once for the comparison window — and bucketing them with a nested filter loop
 * that is buckets × rows. The cost grows with the tenant's entire history and is
 * paid again on every page view.
 *
 * This computes the same numbers ONCE, into buckets small enough that a
 * twelve-month chart is twelve rows.
 *
 * THE LADDER. Raw rows are the fine-grained truth but are unbounded and
 * expensive to scan; a fine-grained SERIES over them (day buckets) is cheap to
 * read but still grows a row per active day forever; a coarse series
 * DOWNSAMPLED from the fine one (month buckets) is small enough to keep for as
 * long as anyone will ask. So each rung is kept for as long as it is worth its
 * size: day buckets for a bounded window, month buckets indefinitely, and raw
 * rows are never scanned for reporting again once the buckets exist.
 *
 * ─── THE FIVE DECISIONS ────────────────────────────────────────────────────
 *
 * 1. WHICH METRICS. Only what the app already reports. Every metric below is a
 *    number the Reports page computes today; nothing is invented. Deliberately
 *    absent: the "win rate by source" column, which is a COHORT measure ("of
 *    the leads created in this window, how many are NOW won") and therefore
 *    not bucketable — see the note on that metric further down.
 *
 * 2. WHICH DATE PUTS A ROW IN A BUCKET: an IMMUTABLE LIFECYCLE DATE, never a
 *    mutable `updatedAt`. This is the single most important rule in the file
 *    and it is explained at length above METRICS.
 *
 * 3. LATE-ARRIVING AND EDITED ROWS: recomputed inside a window, IMMUTABLE once
 *    sealed. A bucket newer than RECOMPUTE_WINDOW_DAYS is recomputed from
 *    source whenever its table changes; older than that it is never touched
 *    again. This is the accounting model — you close the books on a period —
 *    and it is chosen because recomputing arbitrary history needs either a full
 *    rescan or source-side dirty tracking, and neither fits in a cron tick.
 *
 *    Sealing is only SAFE because of decision 2. A sealed bucket that could
 *    still gain rows from the past would be a permanent, undetectable double
 *    count; bucketing on a date that cannot move is what makes "never revisited"
 *    the same thing as "already correct".
 *
 * 4. IDEMPOTENCY: recompute, diff, then write — never increment. The rollup
 *    never adds to a bucket. It recomputes the bucket's whole value from source
 *    and writes it under an id DERIVED from (tenant, metric, period,
 *    bucketStart, dimension), so the second run of a tick addresses the same
 *    rows and computes the same values, and the diff then finds nothing to
 *    write. Running it twice is not merely harmless; it is a no-op that can be
 *    OBSERVED to be a no-op, which is what the tests assert. There is no
 *    "already processed" flag to get wrong, because there is nothing to process
 *    twice.
 *
 * 5. TIMEZONE: Africa/Johannesburg, the app's existing assumption (format.ts
 *    pins every displayed time to it; calendarDates.ts hard-codes the "+02:00"
 *    offset). Bucket edges are SAST midnight, in both the SQL and the
 *    TypeScript, by the same fixed-offset arithmetic. See statisticsTime.ts.
 *
 * ─── COST ──────────────────────────────────────────────────────────────────
 *
 * Same discipline as the journey retention sweep, and for the same reason: this
 * runs once PER TENANT on every cron tick, and on almost all of them there is
 * nothing to do. The common case is ONE read of the (tiny) cursor table plus
 * ONE indexed keyset probe PER SOURCE TABLE, and no write. Everything
 * expensive — the source aggregation, the bucket diff, the writes — happens
 * only after a probe has proven the source actually changed.
 *
 * ─── THE CURSOR INVARIANT ──────────────────────────────────────────────────
 *
 * THE CURSOR ONLY EVER ADVANCES PAST WORK THAT IS ACTUALLY FINISHED. Every
 * bounded step in here (the per-sweep update ceiling, the per-tick backfill
 * slice budget) reports whether it finished, and an unfinished step leaves the
 * cursor exactly where it was. The next tick then re-probes, sees the same
 * changes, and carries on. Advancing a cursor past rows nothing revisited is
 * how a correction is lost permanently and silently, which for a reporting
 * table is indistinguishable from a good month.
 *
 * The same invariant read the other way round decides WHICH position a finished
 * backfill records: the one from when the WALK BEGAN, not from the tick that
 * happened to finish it. A multi-tick backfill aggregated its recent slices
 * days before it aggregated its oldest ones, so a row edited in between was
 * consumed at its old value — and committing today's newest row as the cursor
 * would declare every one of those edits already accounted for.
 */

/* ─── metric catalogue ────────────────────────────────────────────────────── */

export const STATISTIC_SOURCES = ["lead", "jobcard"] as const;
export type StatisticSource = (typeof STATISTIC_SOURCES)[number];

export const STATISTIC_METRICS = [
  "leads_created",
  "deals_won",
  "deals_lost",
  "jobcards_completed",
] as const;
export type StatisticMetric = (typeof STATISTIC_METRICS)[number];

type SourceSpec = {
  /** Physical table, for the raw aggregate. */
  table: string;
  /** Which metrics are derived from it, and therefore recomputed together. */
  metrics: StatisticMetric[];
};

/**
 * A source's `updatedAt` is its CHANGE CLOCK — every model here declares
 * `@updatedAt`, so any write, including the `deletedAt` write of a soft delete,
 * advances it. That is what makes one probe per table sufficient to decide
 * whether any of its metrics can possibly have moved.
 *
 * `updatedAt` is used for THAT and only that. It says "look again"; it never
 * says "and file the row here". See the note above METRICS.
 */
const SOURCES: Record<StatisticSource, SourceSpec> = {
  lead: { table: "Lead", metrics: ["leads_created", "deals_won", "deals_lost"] },
  jobcard: { table: "JobCard", metrics: ["jobcards_completed"] },
};

type MetricSpec = {
  source: StatisticSource;
  /**
   * The column that decides which bucket a row falls in. MUST be immutable for
   * a row that stays in the metric — see the note below.
   */
  dateColumn: string;
  /** Extra predicate — a status filter, a NOT NULL. */
  filter: Prisma.Sql;
  /** Text expression producing the breakdown value, or "" for no breakdown. */
  dimension: Prisma.Sql;
  /** Integer expression summed into `sumCents`. */
  sum: Prisma.Sql;
};

const NO_DIMENSION = Prisma.sql`''`;
const NO_MONEY = Prisma.sql`0`;

/**
 * ─── EVERY METRIC BUCKETS ON AN IMMUTABLE LIFECYCLE DATE ────────────────────
 *
 * A MUTABLE COLUMN MUST NEVER FEED A PERMANENTLY SEALED BUCKET. This was the
 * worst bug in the first version of this file, and it is worth spelling out
 * because it produces wrong numbers that look completely plausible:
 *
 *   A deal is won in March. The March bucket records it. April passes and March
 *   falls out of the 35-day recompute window, so it is SEALED — never revisited.
 *   In August someone opens that deal and adds a note. `Lead.updatedAt` moves to
 *   August. The incremental rollup recomputes the open window, finds the deal
 *   sitting in August, and inserts it into the August bucket. March is outside
 *   the window and keeps its count.
 *
 *   The same deal is now counted in two months. Nothing errors, nothing is
 *   logged, and both months look like ordinary months. Worse still: change that
 *   March win to LOST in August and the historical win stays where it is while a
 *   brand-new loss appears — one deal, two outcomes, both on the chart.
 *
 * So the bucket date is the date the thing being counted HAPPENED, and that date
 * is written once and never moved:
 *
 *   leads_created      → `createdAt`   — immutable by definition.
 *   deals_won          → `wonAt`       — set by the Lead_sync_pipeline_forecast
 *   deals_lost         → `lostAt`         trigger (migration 52) when status
 *                                         first becomes won/lost, and preserved
 *                                         by COALESCE on every later write.
 *   jobcards_completed → `completedAt` — set when the job card is completed.
 *
 * `wonAt` / `lostAt` are columns on the "Lead" TABLE but are in no Prisma model
 * (they are added by 52_pipelines_forecasting_rbac_audit). That does not matter
 * here: the aggregate below is raw SQL against the physical table, so it can
 * name them directly. Migration 20260804120000 backfills the rows that predate
 * the trigger and indexes both columns.
 *
 * A row can still ENTER a metric (a deal closes) or LEAVE it (it is trashed, or
 * re-opened) — both are handled while its bucket is open, because a recompute
 * derives the whole bucket from source rather than adding to it.
 *
 * ─── WHAT THIS DOES NOT FIX, STATED PLAINLY ─────────────────────────────────
 *
 * One movement still crosses a seal, and it is worth being exact about it rather
 * than claiming more than is true. Migration 52's trigger CLEARS `wonAt`/`lostAt`
 * when a deal is re-opened, and `setJobCardStatus` clears `completedAt` when a
 * job card leaves the collected stage. So:
 *
 *   deal won in March (March records it) → March seals → re-opened in August
 *   (`wonAt` becomes NULL, but March is never revisited) → won again in
 *   September (`wonAt` is September). March and September each count it.
 *
 * That is a REVERSAL, not an edit, and the difference is the whole point of the
 * change. Before, the trigger was `updatedAt`: adding a note, changing an
 * assignee, a bulk re-import — ANY write by anyone, on a record nobody meant to
 * restate — moved a deal into the current month and left it in the old one, so
 * totals drifted upward continuously and never reconciled. Now the only thing
 * that does it is a human deliberately un-winning and re-winning a deal, which
 * is a second, genuine commercial event; and a sealed March that says "one deal
 * was won in March" is reporting what was true in March, which is what closing
 * the books means. The alternative — restating sealed history — needs either a
 * full rescan or source-side dirty tracking, and neither fits in a cron tick.
 *
 * It is pinned by a test ("a deal re-won after its first win sealed…") so that
 * it stays a known, bounded property rather than becoming a discovery.
 */
const METRICS: Record<StatisticMetric, MetricSpec> = {
  /**
   * New leads, by the day they were created. Broken down by source, which is
   * what the Reports page's channel chart counts.
   */
  leads_created: {
    source: "lead",
    dateColumn: "createdAt",
    filter: Prisma.empty,
    dimension: Prisma.sql`"source"`,
    sum: Prisma.sql`"valueCents"`,
  },
  /**
   * Deals won, by the date the deal was WON, broken down by assignee.
   *
   * The status filter and the date must agree: `wonAt` survives a later change
   * to lost (the trigger only clears it when the deal is re-opened), so without
   * `status = 'won'` a lost deal would keep counting as a win forever.
   *
   * The range predicate excludes NULL `wonAt` implicitly. After the backfill in
   * migration 20260804120000 there is no such row — an open deal has no `wonAt`
   * and is excluded by the status filter anyway — and that migration asserts it.
   */
  deals_won: {
    source: "lead",
    dateColumn: "wonAt",
    filter: Prisma.sql`AND "status" = 'won'`,
    dimension: Prisma.sql`COALESCE("assignedToId", '')`,
    sum: Prisma.sql`"valueCents"`,
  },
  /** Deals lost, by the date they were lost. Exists to make the win rate a ratio. */
  deals_lost: {
    source: "lead",
    dateColumn: "lostAt",
    filter: Prisma.sql`AND "status" = 'lost'`,
    dimension: NO_DIMENSION,
    sum: Prisma.sql`"valueCents"`,
  },
  /**
   * Workshop job cards completed. `completedAt` is nullable and the aggregate's
   * range predicate already excludes nulls, so no explicit NOT NULL is needed —
   * but the status filter is, because `completedAt` survives a later
   * cancellation.
   */
  jobcards_completed: {
    source: "jobcard",
    dateColumn: "completedAt",
    filter: Prisma.sql`AND "status" <> 'cancelled'`,
    dimension: NO_DIMENSION,
    sum: NO_MONEY,
  },
};

/* ─── tuning ──────────────────────────────────────────────────────────────── */

/**
 * How far back a bucket stays OPEN to recomputation. Past this it is sealed and
 * a later edit to its source rows will not change it.
 *
 * 35 rather than 30: one full calendar month plus four days of slack, so the
 * previous month is still open for the first few days of the current one — the
 * window in which someone actually corrects last month's numbers. Shorter and
 * a correction made on the 2nd would land against a sealed month; much longer
 * and every rollup rescans a quarter of source rows to change nothing.
 */
export const RECOMPUTE_WINDOW_DAYS = 35;

/**
 * How long DAY buckets are kept. Month buckets are kept indefinitely — they are
 * the long-term record and they cost about 60 rows per tenant per year.
 *
 * MUST STAY MUCH LONGER THAN THE MONTH SEAL POINT, because month buckets are
 * DOWNSAMPLED FROM DAY BUCKETS — the coarse series is derived from the fine one,
 * not recomputed from raw history, which is the whole reason the coarse one is
 * cheap. A month is sealed once it falls out of the 35-day window — 65 days at the
 * outside. Pruning its day buckets 750 days later leaves roughly 685 days of
 * headroom. If either number is ever changed, this relationship is the one to
 * preserve, exactly as EVENT_RETENTION_DAYS must outlast the longest journey
 * wait in journeyRetention.ts.
 *
 * 750 also keeps day buckets covering "this year vs last year" (731 days at the
 * worst leap-year alignment) so a two-year daily comparison never falls off the
 * end of the table.
 */
export const DAY_RETENTION_DAYS = 750;

/** Ceiling on bucket deletes per sweep, so pruning cannot eat a whole tick. */
export const MAX_BUCKET_DELETES_PER_SWEEP = 2_000;

/**
 * Ceiling on bucket UPDATES per rollup. Inserts are batched into single
 * statements and are not counted against it; updates are one statement each,
 * which is the shape that can run long.
 *
 * HITTING IT REVOKES COMPLETION. A truncated update pass returns
 * `complete: false`, the source cursor is not advanced, and the next tick sees
 * the same changes and carries on — the buckets it already fixed now match, so
 * the diff skips them and the pass gets strictly further every time. Before
 * this, the ceiling stopped the updates and the cursor advanced anyway, so every
 * correction past row 500 was dropped permanently: not updated, not new, and
 * never looked at again.
 */
export const MAX_BUCKET_UPDATES_PER_SWEEP = 500;

/**
 * How much history one backfill SLICE covers, and how many slices one tick will
 * attempt.
 *
 * The backfill walks BACKWARDS from today in month-aligned slices, recording how
 * far it has got after each one (`StatisticCursor.backfillFrom`). Month-aligned
 * because a month bucket must be computed from a whole month: a slice boundary
 * mid-month would write a partial month and the next slice would overwrite it
 * with the other half.
 *
 * A DURABLE MARKER, not a variable. A workspace with years of history cannot
 * backfill inside one 60-second cron tick, and the first version recorded
 * nothing until an entire source finished — so a tick killed by the route
 * deadline threw away everything it had computed and the next tick started from
 * today again. On a large database that is an infinite loop that never produces
 * a single usable bucket.
 */
export const BACKFILL_SLICE_MONTHS = 6;
export const MAX_BACKFILL_SLICES_PER_TICK = 12;

/** Rows per INSERT during backfill, so one statement stays a sane size. */
const INSERT_CHUNK = 1_000;

/* ─── tenant safety ───────────────────────────────────────────────────────── */

/**
 * The tenant this rollup READS AND WRITES AS.
 *
 * ONE resolution for both halves, and it is resolved from the SCOPE — never from
 * a row that was looked up. A bucket's own `tenantId` must never decide which
 * tenant may touch it; that is circular, and it is how a mis-keyed row becomes a
 * permanent cross-tenant channel.
 *
 * `writeTenantId()` returns the scope's tenant under enforcement, null when
 * enforcement is dormant or the scope is a trusted system scope — the founding
 * tenant stands in there, so a bucket is never written tenantless during the
 * pre-enforcement window — and THROWS when enforcement is on with no usable
 * scope, rather than quietly falling back to everyone's data. This is the same
 * idiom as `repairsTenantId()` and it is deliberate that they match.
 *
 * THE PREDICATE IS APPLIED WHETHER OR NOT ENFORCEMENT IS ON. That is the whole
 * point. `activeTenantPredicate()` deliberately returns NO filter when
 * enforcement is off with no scope, and the db.ts guard adds nothing either — so
 * a rollup that leaned on them wrote and read completely unscoped in the mode
 * every deployment actually runs in today. In an aggregation that does not
 * surface as a visible foreign record; it surfaces as two workspaces' deals
 * silently summed into one number.
 */
export function statisticsTenantId(explicit?: string): string {
  return explicit ?? writeTenantId() ?? DEFAULT_TENANT_ID;
}

/**
 * The tenant predicate for the raw SOURCE aggregates, as SQL — and the same rule
 * as a Prisma `where` fragment for the change probe.
 *
 * BOTH ARE ONE-LINE DELEGATIONS on purpose. The decision itself lives in
 * `statisticsTenantRule.ts`, which imports nothing but the `Prisma` SQL tag, so a
 * test can EXECUTE it; this file cannot be imported from `node:test` without
 * stubbing the module loader, and a rule that can only be pattern-matched is a
 * rule nothing proves. See that file for why a NULL `tenantId` belongs to nobody
 * — including the founding tenant — and for the production evidence that
 * removing the old fallback strands no rows.
 */
function tenantSql(tenantId: string): Prisma.Sql {
  return statisticsScopeSql(statisticsScopeFor({ tenantId }));
}

function tenantWhere(tenantId: string): Record<string, unknown> {
  return statisticsScopeWhere(statisticsScopeFor({ tenantId }));
}

/* ─── identity ────────────────────────────────────────────────────────────── */

/**
 * A bucket's primary key, derived from its natural key.
 *
 * THE IDEMPOTENCY PRIMITIVE. Two runs computing the same bucket compute the
 * same id, so they address the same row; there is no sequence, no counter and
 * no "already applied" marker that a repeat run could misread. It also makes
 * every write to a bucket implicitly tenant-scoped: the id CONTAINS the tenant,
 * so an id built for one workspace cannot address another's row.
 *
 * `dimension` is last on purpose: it is the only free-text component, so it is
 * the only one that could contain the separator, and a trailing field cannot
 * create an ambiguity with anything that follows it.
 */
export function statisticBucketId(
  tenantId: string,
  metric: string,
  period: StatisticPeriod,
  bucketStart: Date,
  dimension: string,
): string {
  return [tenantId, metric, period, bucketStart.toISOString(), dimension].join("|");
}

export function statisticCursorId(tenantId: string, source: StatisticSource): string {
  return [tenantId, source].join("|");
}

/**
 * SAST bucket truncation, in SQL.
 *
 * Plain interval arithmetic, NOT `AT TIME ZONE`. Two reasons, and both are the
 * kind of thing that is silently wrong rather than loudly broken:
 *
 *   - Prisma maps `DateTime` to `timestamp(3)` WITHOUT time zone on Postgres.
 *     `"createdAt" AT TIME ZONE 'Africa/Johannesburg'` on such a column means
 *     "read this local wall-clock as Johannesburg time", which is the opposite
 *     of what is wanted — the stored value is UTC. Getting it right needs a
 *     double conversion through 'UTC' that reads like a typo and invites one.
 *   - SAST has no daylight saving, so `+ 2 hours` is not an approximation of
 *     the timezone rule, it IS the timezone rule — and it is the same
 *     expression as statisticsTime.ts's SAST_OFFSET_MS, so the SQL and the
 *     TypeScript agree by construction instead of by coincidence.
 */
function truncateToPeriod(period: StatisticPeriod, column: Prisma.Sql): Prisma.Sql {
  const unit = Prisma.raw(period === "day" ? "'day'" : "'month'");
  return Prisma.sql`date_trunc(${unit}, ${column} + INTERVAL '2 hours') - INTERVAL '2 hours'`;
}

/* ─── the source aggregate ────────────────────────────────────────────────── */

export type BucketValue = { bucketStart: Date; dimension: string; count: number; sumCents: bigint };

/** `${bucketStart ISO}|${dimension}` — the in-memory key for the diff. */
const bucketKey = (bucketStart: Date, dimension: string) =>
  `${bucketStart.toISOString()}|${dimension}`;

type AggregateRow = { bucketStart: Date; dimension: string | null; count: number; sumCents: bigint };

/**
 * Aggregate one metric straight from its source table, over `[from, to)`.
 *
 * Raw SQL because Prisma has no way to group by a date expression — there is
 * not one `date_trunc` anywhere else in this codebase, which is precisely why
 * every time series in the app is "fetch the window into Node and loop". It is
 * also the only way to read `wonAt` / `lostAt`, which exist on the table but in
 * no Prisma model.
 *
 * `deletedAt IS NULL` is EXPLICIT here. basePrisma is not a soft-delete client
 * (see db.ts), so without it a trashed lead would keep counting towards the
 * numbers forever — the one place where dropping the filter produces a
 * plausible-looking wrong answer rather than an error.
 */
async function aggregateFromSource(
  tenantId: string,
  metric: StatisticMetric,
  period: StatisticPeriod,
  from: Date,
  to: Date,
): Promise<Map<string, BucketValue>> {
  const spec = METRICS[metric];
  const table = Prisma.raw(`"${SOURCES[spec.source].table}"`);
  const dateColumn = Prisma.raw(`"${spec.dateColumn}"`);
  const rows = await basePrisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT ${truncateToPeriod(period, dateColumn)} AS "bucketStart",
           ${spec.dimension} AS "dimension",
           COUNT(*)::int AS "count",
           COALESCE(SUM(${spec.sum}), 0)::bigint AS "sumCents"
    FROM ${table}
    WHERE "deletedAt" IS NULL
      AND ${dateColumn} >= ${from} AND ${dateColumn} < ${to}
      ${spec.filter}
      ${tenantSql(tenantId)}
    GROUP BY 1, 2
  `);
  return toBucketMap(
    rows.map((row) => ({
      bucketStart: new Date(row.bucketStart),
      dimension: row.dimension ?? "",
      count: Number(row.count),
      sumCents: BigInt(row.sumCents),
    })),
  );
}

/**
 * The oldest instant this metric can possibly put in a bucket — the FLOOR of the
 * backfill walk.
 *
 * Without it the backward walk has no end: it would step month by month towards
 * 1970 aggregating nothing. Asked once per metric per tick, only while
 * backfilling, and served by the same tenant-leading index as the aggregate
 * itself (`MIN(col)` over a btree range is an index scan of one row).
 */
async function oldestMetricDate(tenantId: string, metric: StatisticMetric): Promise<Date | null> {
  const spec = METRICS[metric];
  const table = Prisma.raw(`"${SOURCES[spec.source].table}"`);
  const dateColumn = Prisma.raw(`"${spec.dateColumn}"`);
  const rows = await basePrisma.$queryRaw<Array<{ oldest: Date | null }>>(Prisma.sql`
    SELECT MIN(${dateColumn}) AS "oldest"
    FROM ${table}
    WHERE "deletedAt" IS NULL
      ${spec.filter}
      ${tenantSql(tenantId)}
  `);
  const oldest = rows[0]?.oldest ?? null;
  return oldest === null ? null : new Date(oldest);
}

/**
 * Aggregate MONTH buckets by summing this metric's DAY buckets — the
 * downsampling step, and the only place the coarse series is produced on the
 * incremental path.
 *
 * Deriving the long-term series from the short-term one rather than from raw
 * history is much the cheaper of the two, and it is what makes keeping the
 * coarse series forever affordable: a month is at most 31 tiny rows from a
 * table with a few thousand in it, against tens of thousands of source rows. It
 * is safe only because day buckets outlive the month seal point by nearly two
 * years — see DAY_RETENTION_DAYS.
 *
 * IT IS ALSO ONLY SAFE ON A COMPLETE DAY PASS. If the update ceiling truncated
 * the day series, the days it would sum are half old and half new, so the month
 * derived from them would be a number that never existed. The caller therefore
 * skips this entirely when the day pass came back incomplete.
 *
 * (Backfill does NOT use this: it needs months from before the day horizon, so
 * it goes to source. Both are the same aggregate of the same rows.)
 */
async function aggregateFromDayBuckets(
  tenantId: string,
  metric: StatisticMetric,
  from: Date,
  to: Date,
): Promise<Map<string, BucketValue>> {
  const days = await prisma.statisticBucket.findMany({
    where: { tenantId, metric, period: "day", bucketStart: { gte: from, lt: to } },
    select: { bucketStart: true, dimension: true, count: true, sumCents: true },
  });
  const months = new Map<string, BucketValue>();
  for (const day of days) {
    const bucketStart = startOfSastMonth(day.bucketStart);
    const key = bucketKey(bucketStart, day.dimension);
    const current =
      months.get(key) ?? { bucketStart, dimension: day.dimension, count: 0, sumCents: BigInt(0) };
    current.count += day.count;
    current.sumCents += day.sumCents;
    months.set(key, current);
  }
  return months;
}

function toBucketMap(values: BucketValue[]): Map<string, BucketValue> {
  return new Map(values.map((value) => [bucketKey(value.bucketStart, value.dimension), value]));
}

/* ─── the write: recompute, diff, then write ──────────────────────────────── */

type WriteCount = {
  written: number;
  removed: number;
  /**
   * Did this pass apply EVERY change it found? False means the update ceiling
   * cut it short — see MAX_BUCKET_UPDATES_PER_SWEEP — and the caller must not
   * advance anything past it.
   */
  complete: boolean;
};

/**
 * Reconcile the stored buckets for one metric+period over `[from, to)` with a
 * freshly computed set.
 *
 * THE DIFF IS WHAT MAKES IDEMPOTENCY OBSERVABLE. Recomputing and blind-upserting
 * would already be idempotent in its RESULT — the same inputs produce the same
 * value — but it would write the same rows on every tick regardless, so nothing
 * could tell a correct repeat run from a broken one. Writing only what actually
 * changed means a second run of the same tick issues NO writes at all, which is
 * an assertion a test can make.
 *
 * A stored bucket the recompute did not produce is DELETED, not left behind: it
 * means every source row that fed it is gone (trashed, or re-opened), and a
 * bucket nobody will overwrite is a number that stays on the chart forever.
 *
 * EVERY statement here names the tenant. The scoped client's guard adds nothing
 * while enforcement is dormant, so `where: { id }` alone would let a bucket be
 * addressed across workspaces; the ids happen to embed the tenant, which is a
 * reason it is safe, not a reason to leave the predicate out.
 */
async function applyBuckets(
  tenantId: string,
  metric: StatisticMetric,
  period: StatisticPeriod,
  from: Date,
  to: Date,
  computed: Map<string, BucketValue>,
): Promise<WriteCount> {
  const existing = await prisma.statisticBucket.findMany({
    where: { tenantId, metric, period, bucketStart: { gte: from, lt: to } },
    select: { id: true, bucketStart: true, dimension: true, count: true, sumCents: true },
  });

  // THE DIFF, computed in full BEFORE anything is written. Classifying every
  // stored bucket first is what lets the update ceiling below truncate the
  // WRITES without also truncating the KNOWLEDGE: `stored` and `stale` are
  // complete whether or not the budget runs out, so the insert set is exact and
  // no emptied bucket is missed. A single loop that broke at the ceiling left
  // both sets half-built, and then re-inserted rows it had simply not looked at
  // yet.
  const stored = new Set<string>();
  const stale: string[] = [];
  const changed: Array<{ id: string; next: BucketValue }> = [];

  for (const row of existing) {
    const key = bucketKey(row.bucketStart, row.dimension);
    stored.add(key);
    const next = computed.get(key);
    if (!next) {
      stale.push(row.id);
      continue;
    }
    // Unchanged buckets — nearly all of them, on nearly every tick — cost
    // nothing but the comparison.
    if (row.count === next.count && row.sumCents === next.sumCents) continue;
    changed.push({ id: row.id, next });
  }

  // OUT OF BUDGET, NOT OUT OF WORK. Applying the first N and saying so is the
  // whole point: the caller leaves the cursor alone, the next tick re-probes,
  // and the buckets already fixed now match so the diff skips them — the pass
  // gets strictly further every time. Reporting `complete: true` here is how
  // every correction past row N becomes permanently invisible.
  const complete = changed.length <= MAX_BUCKET_UPDATES_PER_SWEEP;
  const applying = complete ? changed : changed.slice(0, MAX_BUCKET_UPDATES_PER_SWEEP);
  for (const { id, next } of applying) {
    await prisma.statisticBucket.updateMany({
      where: { id, tenantId },
      data: { count: next.count, sumCents: next.sumCents, computedAt: new Date() },
    });
  }

  // Inserts and deletes still run on an incomplete pass. They are correct on
  // their own terms — a brand-new bucket and an emptied one are both facts about
  // source, not about how far the update loop got — and doing them now means the
  // retry has strictly less to do. The cursor still does not move.
  const fresh = [...computed.values()].filter(
    (value) => !stored.has(bucketKey(value.bucketStart, value.dimension)),
  );
  let inserted = 0;
  for (let index = 0; index < fresh.length; index += INSERT_CHUNK) {
    const chunk = fresh.slice(index, index + INSERT_CHUNK);
    // `skipDuplicates` is the concurrency guard, not a convenience: two
    // overlapping cron runs both computing a brand-new bucket would otherwise
    // race, and the loser would abort the whole rollup on a primary-key
    // violation. They compute the SAME id and the SAME value, so the loser has
    // nothing to add. Counting the rows Postgres actually took, rather than the
    // rows offered, keeps `bucketsWritten` an observation instead of a guess.
    const { count } = await prisma.statisticBucket.createMany({
      data: chunk.map((value) => ({
        id: statisticBucketId(tenantId, metric, period, value.bucketStart, value.dimension),
        tenantId,
        metric,
        period,
        bucketStart: value.bucketStart,
        dimension: value.dimension,
        count: value.count,
        sumCents: value.sumCents,
      })),
      skipDuplicates: true,
    });
    inserted += count;
  }

  if (stale.length > 0) {
    await prisma.statisticBucket.deleteMany({ where: { tenantId, id: { in: stale } } });
  }
  return { written: applying.length + inserted, removed: stale.length, complete };
}

/* ─── change detection ────────────────────────────────────────────────────── */

type SourceRow = { id: string; updatedAt: Date };

/**
 * Source rows are read through `basePrisma`, WITH AN EXPLICIT TENANT PREDICATE.
 *
 * Not a shortcut — the scoped client would be wrong here. `prisma` hides
 * soft-deleted rows, and a soft delete is exactly the change this probe must
 * notice: trashing a won deal has to remove it from its bucket, and through the
 * filtered client the row simply vanishes and the change goes unseen. So the
 * probe reads the unfiltered client and names the tenant itself — the SAME
 * tenant the buckets are stamped with, so what the probe watches and what the
 * rollup writes can never disagree.
 *
 * The keyset predicate is in the only shape Lead and JobCard share. Both carry
 * `id` and `updatedAt`, so one filter serves both — spelled out rather than
 * intersecting the two generated WhereInputs, which produces a type Prisma
 * cannot accept back. It is combined with the tenant term under `AND` because
 * both halves are an `OR`, and two `OR` keys cannot share one object.
 */
type ChangeWhere = {
  OR?: Array<{ updatedAt?: Date | { gt: Date }; id?: { gt: string } }>;
};

async function findSourceRow(
  tenantId: string,
  source: StatisticSource,
  where: ChangeWhere,
  direction: "asc" | "desc",
): Promise<SourceRow | null> {
  const args = {
    where: { AND: [tenantWhere(tenantId), where] },
    orderBy: [{ updatedAt: direction }, { id: direction }],
    select: { id: true, updatedAt: true },
  };
  return source === "lead"
    ? basePrisma.lead.findFirst(args)
    : basePrisma.jobCard.findFirst(args);
}

/**
 * THE EARLY OUT: has anything in this table changed since the cursor?
 *
 * One indexed probe, and it must stay one. The keyset — strictly-greater on
 * `updatedAt`, tie-broken on `id` — is what lets it be exact AND cheap:
 * ascending order means the index seeks straight to the cursor position and
 * either returns the very next row or terminates immediately. Ordering
 * DESCENDING to grab the newest change instead would look equivalent and would
 * be a full index scan every time the answer is "nothing changed", which is
 * nearly every time.
 *
 * The `id` tie-break is not paranoia: Prisma's DateTime is millisecond
 * precision and a bulk import writes hundreds of rows inside one, so a
 * timestamp-only cursor either re-reads a millisecond forever or steps over it.
 */
async function changedSince(
  tenantId: string,
  source: StatisticSource,
  cursorAt: Date,
  cursorId: string,
): Promise<boolean> {
  const row = await findSourceRow(
    tenantId,
    source,
    { OR: [{ updatedAt: { gt: cursorAt } }, { updatedAt: cursorAt, id: { gt: cursorId } }] },
    "asc",
  );
  return row !== null;
}

/** The newest row in the table — the cursor position to record. */
function newestSourceRow(tenantId: string, source: StatisticSource): Promise<SourceRow | null> {
  return findSourceRow(tenantId, source, {}, "desc");
}

/* ─── the rollup ──────────────────────────────────────────────────────────── */

export type RollupResult = {
  /** Sources whose buckets were recomputed this run. */
  recomputed: number;
  /** Sources whose whole history FINISHED being built this run. */
  backfilled: number;
  bucketsWritten: number;
  bucketsRemoved: number;
  bucketsPruned: number;
  /**
   * Did every source finish the work it started? False means at least one
   * cursor was deliberately left where it was, and the next tick resumes.
   */
  complete: boolean;
  /** Sources still part-way through their initial backfill. */
  backfillPending: number;
};

const EMPTY_RESULT: RollupResult = {
  recomputed: 0,
  backfilled: 0,
  bucketsWritten: 0,
  bucketsRemoved: 0,
  bucketsPruned: 0,
  complete: true,
  backfillPending: 0,
};

export type RollupOptions = {
  /**
   * The tenant to roll up. Supplied by the cron runner, which already knows
   * which slice it is running; omitted it falls back to the request/cron scope.
   * Either way it is resolved ONCE, here, and threaded explicitly through every
   * query below — never re-derived deeper down and never taken off a row.
   */
  tenantId?: string;
  /**
   * "Is this tick's budget spent?", checked between backfill slices. Returning
   * true stops the walk cleanly at a slice boundary with its progress recorded,
   * instead of the route being killed mid-slice.
   */
  shouldStop?: () => boolean;
};

function tally(result: RollupResult, write: WriteCount): boolean {
  result.bucketsWritten += write.written;
  result.bucketsRemoved += write.removed;
  return write.complete;
}

const earlier = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/**
 * Roll up statistics for one tenant. Safe to run every tick, safe to run twice,
 * and correct after any number of missed ticks — a missed tick just means the
 * next one finds more changed and recomputes the same window it would have
 * anyway.
 */
export async function rollUpStatistics(
  now: Date = new Date(),
  options: RollupOptions = {},
): Promise<RollupResult> {
  const tenantId = statisticsTenantId(options.tenantId);
  const shouldStop = options.shouldStop ?? (() => false);
  const result = { ...EMPTY_RESULT };

  const cursors = new Map(
    (await prisma.statisticCursor.findMany({
      where: { tenantId },
      select: {
        source: true,
        cursorAt: true,
        cursorId: true,
        backfilledAt: true,
        backfillFrom: true,
      },
    })).map((row) => [row.source as StatisticSource, row]),
  );

  for (const source of STATISTIC_SOURCES) {
    const cursor = cursors.get(source);
    const backfilling = !cursor?.backfilledAt;

    // THE EARLY OUT. One indexed probe, then done — on nearly every tick, for
    // nearly every tenant.
    if (!backfilling && !(await changedSince(tenantId, source, cursor.cursorAt, cursor.cursorId))) {
      continue;
    }

    // The new cursor is read BEFORE the recompute, never after. A source row
    // written while the aggregates are running is then still beyond the cursor
    // on the next tick, so it cannot be skipped; at worst it is counted twice,
    // and counting twice is free because the recompute derives the whole
    // bucket rather than adding to it.
    //
    // AN EMPTY TABLE IS A COMPLETE HISTORY, not a reason to skip. A workspace
    // with no job cards has nothing to roll up and is nonetheless fully rolled
    // up; refusing to record that would leave `readyStatisticSources` reporting
    // "not built yet" for ever, and every reader stuck on the live query
    // waiting for a backfill with nothing to do. The cursor is then the epoch,
    // so the first row that ever appears is beyond it.
    const newest = (await newestSourceRow(tenantId, source)) ?? { id: "", updatedAt: new Date(0) };

    // WHERE THE CURSOR WILL LAND IF THIS TICK FINISHES.
    //
    // For an incremental pass that is `newest`, read above. For a BACKFILL it is
    // the position captured when the WALK STARTED, which may have been several
    // ticks ago — and that difference is a correctness one, not bookkeeping.
    //
    // A backfill too large for one tick builds its recent slices first and its
    // oldest slices last. A deal edited between those ticks was aggregated by an
    // earlier slice at its OLD value; only the incremental pass can restate it,
    // and the incremental pass only looks at rows beyond the cursor. Recording
    // the row that is newest on the tick that happens to finish the walk steps
    // over every such edit at once, and nothing revisits them — the buckets keep
    // a value that was true days ago and no later tick disagrees.
    const position =
      backfilling && cursor ? { id: cursor.cursorId, updatedAt: cursor.cursorAt } : newest;

    const complete = backfilling
      ? await backfillSource(
          tenantId, source, now, cursor?.backfillFrom ?? null, newest, shouldStop, result,
        )
      : await recomputeWindow(tenantId, source, now, result);

    result.recomputed += 1;

    // THE CURSOR INVARIANT. Unfinished work leaves the cursor exactly where it
    // was, so the next tick's probe still sees the same changes. Advancing it
    // here would mean the rows the ceiling refused are never revisited by
    // anything, ever — silently wrong numbers with no way back.
    if (!complete) {
      result.complete = false;
      if (backfilling) result.backfillPending += 1;
      continue;
    }

    const id = statisticCursorId(tenantId, source);
    await prisma.statisticCursor.upsert({
      // `id` is a pure function of (tenantId, source) — see statisticCursorId —
      // so this can only ever address THIS tenant's row.
      where: { id },
      create: {
        id,
        tenantId,
        source,
        cursorAt: position.updatedAt,
        cursorId: position.id,
        backfilledAt: now,
      },
      update: {
        cursorAt: position.updatedAt,
        cursorId: position.id,
        // Never re-stamped: it records when history was first built, and it is
        // what selects the backfill path. Re-stamping it would be harmless
        // today and would silently disable backfill detection if the field
        // ever gained a second reader.
        //
        // `backfillFrom` is cleared in the same statement, so "the walk is
        // finished" and "the walk has got this far" can never both be readable
        // — a stale marker beside a stamped `backfilledAt` is the state a future
        // reader would most plausibly misinterpret as a resumable backfill.
        ...(backfilling ? { backfilledAt: now, backfillFrom: null } : {}),
      },
    });

    if (backfilling) result.backfilled += 1;
  }

  result.bucketsPruned = await pruneDayBuckets(tenantId, now);
  return result;
}

/**
 * The INCREMENTAL path: recompute the open window from source.
 *
 * Returns false if any pass was truncated, which stops the caller advancing the
 * cursor.
 */
async function recomputeWindow(
  tenantId: string,
  source: StatisticSource,
  now: Date,
  result: RollupResult,
): Promise<boolean> {
  const today = startOfSastDay(now);
  const dayTo = addPeriods("day", today, 1);
  const dayFrom = addPeriods("day", today, -(RECOMPUTE_WINDOW_DAYS - 1));
  // The month window is DERIVED from the day window, never chosen separately.
  // A month may only be sealed once every day inside it is sealed; deriving
  // it guarantees that instead of relying on two constants staying in step.
  const monthFrom = startOfSastMonth(dayFrom);
  const monthTo = addPeriods("month", startOfSastMonth(now), 1);

  let complete = true;
  for (const metric of SOURCES[source].metrics) {
    const days = await aggregateFromSource(tenantId, metric, "day", dayFrom, dayTo);
    if (!tally(result, await applyBuckets(tenantId, metric, "day", dayFrom, dayTo, days))) {
      // A half-updated day series must not be downsampled — the month would be
      // a total that was never true of any moment. Leave the month alone and
      // come back to both next tick.
      complete = false;
      continue;
    }
    const months = await aggregateFromDayBuckets(tenantId, metric, monthFrom, monthTo);
    if (!tally(result, await applyBuckets(tenantId, metric, "month", monthFrom, monthTo, months))) {
      complete = false;
    }
  }
  return complete;
}

/**
 * The BACKFILL path: build history once, walking backwards in month-aligned
 * slices and recording how far it got after every one.
 *
 * RESUMABLE BY CONSTRUCTION. `StatisticCursor.backfillFrom` is written after
 * each completed slice, so a tick that runs out of budget — or a route killed
 * outright by the platform deadline — costs at most one slice of work. The
 * previous version recorded nothing until an entire source's history was built,
 * so on a database large enough to exceed the tick budget the backfill restarted
 * from today on every tick and never finished: not slow, non-terminating.
 *
 * The walk stops at the oldest row that could contribute to any of this source's
 * metrics. Without that floor there is no end to walk to.
 */
async function backfillSource(
  tenantId: string,
  source: StatisticSource,
  now: Date,
  resumeFrom: Date | null,
  /**
   * The source's newest row as of THIS tick, recorded alongside the first slice
   * of progress so a multi-tick walk remembers where it began. See `position` in
   * {@link rollUpStatistics} for why the start, not the end, is the safe cursor.
   */
  startPosition: SourceRow,
  shouldStop: () => boolean,
  result: RollupResult,
): Promise<boolean> {
  const today = startOfSastDay(now);
  const dayTo = addPeriods("day", today, 1);
  const dayHorizon = addPeriods("day", today, -(DAY_RETENTION_DAYS - 1));
  const monthTo = addPeriods("month", startOfSastMonth(now), 1);

  const oldest = await Promise.all(
    SOURCES[source].metrics.map((metric) => oldestMetricDate(tenantId, metric)),
  );
  const present = oldest.filter((date): date is Date => date !== null);
  // No rows at all: an empty table is a complete history, and `monthTo` as the
  // floor makes the walk below terminate immediately with `complete: true`.
  const floor = present.length === 0
    ? monthTo
    : startOfSastMonth(present.reduce((a, b) => earlier(a, b)));

  let sliceTo = resumeFrom ?? monthTo;

  for (let slice = 0; slice < MAX_BACKFILL_SLICES_PER_TICK; slice++) {
    if (sliceTo.getTime() <= floor.getTime()) return true;
    // Checked BEFORE the slice, so a stop always lands on a recorded boundary.
    if (shouldStop()) return false;

    const sliceFrom = later(addPeriods("month", sliceTo, -BACKFILL_SLICE_MONTHS), floor);
    // Day buckets only exist inside the retention horizon; older slices get
    // months only. `dayTo` clamps the newest slice, which extends to the end of
    // the current month.
    const dayFrom = later(sliceFrom, dayHorizon);
    const dayRangeTo = earlier(sliceTo, dayTo);

    let complete = true;
    for (const metric of SOURCES[source].metrics) {
      if (dayFrom.getTime() < dayRangeTo.getTime()) {
        const days = await aggregateFromSource(tenantId, metric, "day", dayFrom, dayRangeTo);
        if (!tally(result, await applyBuckets(tenantId, metric, "day", dayFrom, dayRangeTo, days))) {
          complete = false;
        }
      }
      // Months come from SOURCE here, not from day buckets: a slice older than
      // the day horizon has no day buckets to downsample.
      const months = await aggregateFromSource(tenantId, metric, "month", sliceFrom, sliceTo);
      if (!tally(result, await applyBuckets(tenantId, metric, "month", sliceFrom, sliceTo, months))) {
        complete = false;
      }
    }
    // The progress marker is the same invariant as the cursor: it never moves
    // past a slice that was not finished.
    if (!complete) return false;

    await recordBackfillProgress(tenantId, source, sliceFrom, startPosition);
    sliceTo = sliceFrom;
  }

  return sliceTo.getTime() <= floor.getTime();
}

/**
 * Persist "history is built from here forwards" for a source mid-backfill, and
 * — on the first slice only — WHERE THE WALK BEGAN.
 *
 * The row is created with the change-clock position read at the start of the
 * very first tick and `cursorAt` is never rewritten afterwards, so however many
 * ticks the walk takes, the cursor it finally commits is the one from before any
 * of it ran. No reader is misled in the meantime: `changedSince` is only asked
 * once `backfilledAt` is set, and `readyStatisticSources` reports the source as
 * unbuilt until then, so this row exists purely as the resume record.
 */
async function recordBackfillProgress(
  tenantId: string,
  source: StatisticSource,
  backfillFrom: Date,
  startPosition: SourceRow,
): Promise<void> {
  const id = statisticCursorId(tenantId, source);
  await prisma.statisticCursor.upsert({
    where: { id },
    create: {
      id,
      tenantId,
      source,
      cursorAt: startPosition.updatedAt,
      cursorId: startPosition.id,
      backfillFrom,
    },
    // `cursorAt` / `cursorId` are deliberately absent: a later tick of the same
    // walk must not drag the start position forward past the edits it is the
    // incremental pass's job to catch.
    update: { backfillFrom },
  });
}

/**
 * Drop day buckets past the retention horizon. Month buckets are never pruned —
 * they are the long-term record and the reason day buckets can be.
 *
 * Shaped exactly like the journey retention sweep, for the same reason: one
 * indexed lookup decides whether there is any work, the delete names the rows
 * it removes rather than re-running the age filter, and the batch is bounded so
 * one tick cannot spend itself here.
 */
async function pruneDayBuckets(tenantId: string, now: Date): Promise<number> {
  const cutoff = addPeriods("day", startOfSastDay(now), -DAY_RETENTION_DAYS);
  const expired = await prisma.statisticBucket.findMany({
    where: { tenantId, period: "day", bucketStart: { lt: cutoff } },
    orderBy: { bucketStart: "asc" },
    take: MAX_BUCKET_DELETES_PER_SWEEP,
    select: { id: true },
  });
  if (expired.length === 0) return 0;
  const { count } = await prisma.statisticBucket.deleteMany({
    where: { tenantId, id: { in: expired.map((row) => row.id) } },
  });
  return count;
}

/* ─── reads ───────────────────────────────────────────────────────────────── */

export type StatisticRow = {
  bucketStart: Date;
  dimension: string;
  count: number;
  sumCents: number;
};

/**
 * Which sources have a complete bucket history, FOR ONE TENANT.
 *
 * A reader MUST check this before trusting the buckets. Between the deploy and
 * the first cron tick there are no buckets at all, and a chart that silently
 * reads an unbuilt table shows a flat zero line — which looks like a business
 * collapse rather than a cold start. Callers fall back to the live query until
 * this says otherwise. A tenant whose backfill is still walking has no
 * `backfilledAt` yet and is correctly reported as unbuilt.
 */
export async function readyStatisticSources(tenantId?: string): Promise<Set<StatisticSource>> {
  const rows = await prisma.statisticCursor.findMany({
    where: { tenantId: statisticsTenantId(tenantId), backfilledAt: { not: null } },
    select: { source: true },
  });
  return new Set(rows.map((row) => row.source as StatisticSource));
}

/** Is every metric in `metrics` backed by a built bucket history for this tenant? */
export async function statisticsReadyFor(
  metrics: StatisticMetric[],
  tenantId?: string,
): Promise<boolean> {
  const ready = await readyStatisticSources(statisticsTenantId(tenantId));
  return metrics.every((metric) => ready.has(METRICS[metric].source));
}

/**
 * Read one metric's buckets over `[from, to)`, for one tenant.
 *
 * The bounded read the whole feature exists for: at most one row per bucket per
 * dimension, where the query it replaces returned one row per source record.
 *
 * THE TENANT IS NAMED HERE TOO. The scoped client adds no predicate while
 * enforcement is dormant, so without this a second workspace's Reports page
 * reads the founding tenant's buckets — the same hole as on the write side, and
 * quieter, because aggregates carry no recognisable foreign record.
 */
export async function readStatisticBuckets(options: {
  metric: StatisticMetric;
  period: StatisticPeriod;
  from: Date;
  to: Date;
  tenantId?: string;
}): Promise<StatisticRow[]> {
  const rows = await prisma.statisticBucket.findMany({
    where: {
      tenantId: statisticsTenantId(options.tenantId),
      metric: options.metric,
      period: options.period,
      bucketStart: { gte: startOfPeriod(options.period, options.from), lt: options.to },
    },
    orderBy: { bucketStart: "asc" },
    select: { bucketStart: true, dimension: true, count: true, sumCents: true },
  });
  return rows.map((row) => ({
    bucketStart: row.bucketStart,
    dimension: row.dimension,
    count: row.count,
    // Cents as a Number for the UI. Safe to 2^53 cents — about R90 trillion —
    // which is several orders of magnitude past any total this app will hold,
    // and the alternative is threading BigInt through every chart component.
    sumCents: Number(row.sumCents),
  }));
}

/** Fold bucket rows to a single total. Pure, so the arithmetic is testable. */
export function totalOf(rows: StatisticRow[]): { count: number; sumCents: number } {
  return rows.reduce(
    (total, row) => ({ count: total.count + row.count, sumCents: total.sumCents + row.sumCents }),
    { count: 0, sumCents: 0 },
  );
}

/** Fold bucket rows onto a fixed axis of bucket starts. Pure. */
export function seriesOf(
  rows: StatisticRow[],
  axis: Date[],
): Array<{ count: number; sumCents: number }> {
  const byBucket = new Map<number, { count: number; sumCents: number }>();
  for (const row of rows) {
    const key = row.bucketStart.getTime();
    const current = byBucket.get(key) ?? { count: 0, sumCents: 0 };
    current.count += row.count;
    current.sumCents += row.sumCents;
    byBucket.set(key, current);
  }
  return axis.map((start) => byBucket.get(start.getTime()) ?? { count: 0, sumCents: 0 });
}

/** Fold bucket rows by dimension value. Pure. */
export function breakdownOf(rows: StatisticRow[]): Map<string, { count: number; sumCents: number }> {
  const byDimension = new Map<string, { count: number; sumCents: number }>();
  for (const row of rows) {
    const current = byDimension.get(row.dimension) ?? { count: 0, sumCents: 0 };
    current.count += row.count;
    current.sumCents += row.sumCents;
    byDimension.set(row.dimension, current);
  }
  return byDimension;
}

/** The bucket axis a range of this length should be charted on. */
export { periodStarts, periodForRange } from "./statisticsTime";
