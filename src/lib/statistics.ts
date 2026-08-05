import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "./db";
import { activeTenantPredicate } from "./tenantPredicate";
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
 * ─── THE FOUR DECISIONS ────────────────────────────────────────────────────
 *
 * 1. WHICH METRICS. Only what the app already reports. Every metric below is a
 *    number the Reports page computes today; nothing is invented. Deliberately
 *    absent: the "win rate by source" column, which is a COHORT measure ("of
 *    the leads created in this window, how many are NOW won") and therefore
 *    not bucketable — see the note on that metric further down.
 *
 * 2. LATE-ARRIVING AND EDITED ROWS: recomputed inside a window, IMMUTABLE once
 *    sealed. A bucket newer than RECOMPUTE_WINDOW_DAYS is recomputed from
 *    source whenever its table changes; older than that it is never touched
 *    again. This is the accounting model — you close the books on a period —
 *    and it is chosen for two reasons. The cheap one: recomputing arbitrary
 *    history needs either a full rescan or source-side dirty tracking, and
 *    neither fits in a cron tick. The real one: a sealed bucket PINS what the
 *    numbers were, where the live query silently rewrites them. The Reports
 *    page dates a won deal by `Lead.updatedAt` (there is no wonAt in the Prisma
 *    schema), so today a note added to a deal closed in March moves that deal's
 *    value out of March and into August — history changes because someone typed
 *    a comment. The buckets do not do that. They record what March looked like.
 *
 * 3. IDEMPOTENCY: recompute, diff, then write — never increment. The rollup
 *    never adds to a bucket. It recomputes the bucket's whole value from source
 *    and writes it under an id DERIVED from (tenant, metric, period,
 *    bucketStart, dimension), so the second run of a tick addresses the same
 *    rows and computes the same values, and the diff then finds nothing to
 *    write. Running it twice is not merely harmless; it is a no-op that can be
 *    OBSERVED to be a no-op, which is what the tests assert. There is no
 *    "already processed" flag to get wrong, because there is nothing to process
 *    twice.
 *
 * 4. TIMEZONE: Africa/Johannesburg, the app's existing assumption (format.ts
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
 */
const SOURCES: Record<StatisticSource, SourceSpec> = {
  lead: { table: "Lead", metrics: ["leads_created", "deals_won", "deals_lost"] },
  jobcard: { table: "JobCard", metrics: ["jobcards_completed"] },
};

type MetricSpec = {
  source: StatisticSource;
  /** The column that decides which bucket a row falls in. */
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

const METRICS: Record<StatisticMetric, MetricSpec> = {
  /**
   * New leads, by the day they were created. Broken down by source, which is
   * what the Reports page's channel chart counts.
   *
   * `createdAt` is immutable, so a row can only ever ENTER this metric's
   * buckets (a new lead) or leave them (a soft delete) — it can never migrate
   * between buckets. That is the well-behaved case and the reason this one is
   * exactly reproducible for as far back as the buckets go.
   */
  leads_created: {
    source: "lead",
    dateColumn: "createdAt",
    filter: Prisma.empty,
    dimension: Prisma.sql`"source"`,
    sum: Prisma.sql`"valueCents"`,
  },
  /**
   * Deals won, by `updatedAt`, broken down by assignee.
   *
   * `updatedAt` IS THE APP'S EXISTING PROXY FOR THE WIN DATE and this
   * deliberately reproduces it rather than improving on it: the Reports page,
   * the dashboard and the targets scorecard all date a won deal this way, and a
   * bucket that disagreed with the page it feeds would be a worse bug than the
   * proxy. (`Lead.wonAt` exists in the DATABASE — added by migration
   * 52_pipelines_forecasting_rbac_audit and maintained by a trigger — but it is
   * in no Prisma model, so no Prisma query can select it. Exposing it means
   * editing schema.prisma, which parallel work has open.)
   *
   * The consequence is stated in decision 2 above and is the strongest argument
   * for sealing: under the proxy, editing an old won deal moves its value into
   * the current month. The live query rewrites history each time that happens;
   * the sealed bucket does not.
   */
  deals_won: {
    source: "lead",
    dateColumn: "updatedAt",
    filter: Prisma.sql`AND "status" = 'won'`,
    dimension: Prisma.sql`COALESCE("assignedToId", '')`,
    sum: Prisma.sql`"valueCents"`,
  },
  /** Deals lost, by the same proxy. Exists only to make the win rate a ratio. */
  deals_lost: {
    source: "lead",
    dateColumn: "updatedAt",
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
 */
export const MAX_BUCKET_UPDATES_PER_SWEEP = 500;

/** Rows per INSERT during backfill, so one statement stays a sane size. */
const INSERT_CHUNK = 1_000;

/* ─── identity ────────────────────────────────────────────────────────────── */

/**
 * A bucket's primary key, derived from its natural key.
 *
 * THE IDEMPOTENCY PRIMITIVE. Two runs computing the same bucket compute the
 * same id, so they address the same row; there is no sequence, no counter and
 * no "already applied" marker that a repeat run could misread.
 *
 * `dimension` is last on purpose: it is the only free-text component, so it is
 * the only one that could contain the separator, and a trailing field cannot
 * create an ambiguity with anything that follows it.
 */
export function statisticBucketId(
  tenantId: string | null,
  metric: string,
  period: StatisticPeriod,
  bucketStart: Date,
  dimension: string,
): string {
  return [tenantId ?? "-", metric, period, bucketStart.toISOString(), dimension].join("|");
}

export function statisticCursorId(tenantId: string | null, source: StatisticSource): string {
  return [tenantId ?? "-", source].join("|");
}

/* ─── tenant safety ───────────────────────────────────────────────────────── */

/**
 * The active tenant, for building ids and for the raw SQL predicate below.
 *
 * Aggregation is exactly where a missing tenant predicate stops being a leak
 * and becomes a WRONG NUMBER — two workspaces' deals silently summed into one
 * chart, with nothing on screen to say so. So the raw path names the tenant
 * explicitly and this is the single place it is resolved.
 */
function activeTenantId(context: string): string | null {
  const scope = activeTenantPredicate(context);
  return "tenantId" in scope ? scope.tenantId ?? null : null;
}

/**
 * The active tenant as a SQL fragment for the raw aggregates.
 *
 * `$queryRaw` and `basePrisma` BOTH BYPASS the tenant extension, and the
 * aggregate below uses both — raw because Prisma cannot group by a date
 * expression, and basePrisma because raw calls on the scoped client set no RLS
 * GUC at all. So the predicate the extension would have added has to be added
 * here, by hand, and this is it.
 *
 * `IS NOT DISTINCT FROM` rather than `=`: legacy rows carry `tenantId IS NULL`
 * and a scope genuinely carrying null must match them, which `= NULL` never
 * does. `Prisma.empty` when enforcement is dormant is the documented behaviour
 * of activeTenantPredicate — no scope means nobody told us which tenant this
 * is, which is not a filter (and dormant mode runs one unscoped sweep anyway).
 */
function tenantSql(context: string): Prisma.Sql {
  const scope = activeTenantPredicate(context);
  if (!("tenantId" in scope)) return Prisma.empty;
  return Prisma.sql`AND "tenantId" IS NOT DISTINCT FROM ${scope.tenantId ?? null}::text`;
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
 * every time series in the app is "fetch the window into Node and loop".
 *
 * `deletedAt IS NULL` is EXPLICIT here. basePrisma is not a soft-delete client
 * (see db.ts), so without it a trashed lead would keep counting towards the
 * numbers forever — the one place where dropping the filter produces a
 * plausible-looking wrong answer rather than an error.
 */
async function aggregateFromSource(
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
      ${tenantSql(`statistics rollup (${metric})`)}
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
 * (Backfill does NOT use this: it needs months from before the day horizon, so
 * it goes to source. Both are the same aggregate of the same rows.)
 */
async function aggregateFromDayBuckets(
  metric: StatisticMetric,
  from: Date,
  to: Date,
): Promise<Map<string, BucketValue>> {
  const days = await prisma.statisticBucket.findMany({
    where: { metric, period: "day", bucketStart: { gte: from, lt: to } },
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

type WriteCount = { written: number; removed: number };

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
 * means every source row that fed it is gone (trashed, or edited into a
 * different bucket), and a bucket nobody will overwrite is a number that stays
 * on the chart forever.
 */
async function applyBuckets(
  tenantId: string | null,
  metric: StatisticMetric,
  period: StatisticPeriod,
  from: Date,
  to: Date,
  computed: Map<string, BucketValue>,
): Promise<WriteCount> {
  const existing = await prisma.statisticBucket.findMany({
    where: { metric, period, bucketStart: { gte: from, lt: to } },
    select: { id: true, bucketStart: true, dimension: true, count: true, sumCents: true },
  });

  const stored = new Set<string>();
  const stale: string[] = [];
  let written = 0;

  for (const row of existing) {
    const key = bucketKey(row.bucketStart, row.dimension);
    stored.add(key);
    const next = computed.get(key);
    if (!next) {
      stale.push(row.id);
      continue;
    }
    // THE DIFF. Unchanged buckets — nearly all of them, on nearly every tick —
    // cost nothing but the comparison.
    if (row.count === next.count && row.sumCents === next.sumCents) continue;
    if (written >= MAX_BUCKET_UPDATES_PER_SWEEP) break;
    await prisma.statisticBucket.update({
      where: { id: row.id },
      data: { count: next.count, sumCents: next.sumCents, computedAt: new Date() },
    });
    written += 1;
  }

  const fresh = [...computed.values()].filter(
    (value) => !stored.has(bucketKey(value.bucketStart, value.dimension)),
  );
  for (let index = 0; index < fresh.length; index += INSERT_CHUNK) {
    const chunk = fresh.slice(index, index + INSERT_CHUNK);
    // `skipDuplicates` is the concurrency guard, not a convenience: two
    // overlapping cron runs both computing a brand-new bucket would otherwise
    // race, and the loser would abort the whole rollup on a primary-key
    // violation. They compute the SAME id and the SAME value, so the loser has
    // nothing to add.
    await prisma.statisticBucket.createMany({
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
    written += chunk.length;
  }

  if (stale.length > 0) {
    await prisma.statisticBucket.deleteMany({ where: { id: { in: stale } } });
  }
  return { written, removed: stale.length };
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
 * probe reads the unfiltered client and names the tenant itself.
 */
/**
 * The keyset predicate, in the only shape Lead and JobCard share. Both carry
 * `id` and `updatedAt`, so one filter serves both — spelled out rather than
 * intersecting the two generated WhereInputs, which produces a type Prisma
 * cannot accept back.
 */
type ChangeWhere = {
  OR?: Array<{ updatedAt?: Date | { gt: Date }; id?: { gt: string } }>;
};

async function findSourceRow(
  source: StatisticSource,
  where: ChangeWhere,
  direction: "asc" | "desc",
): Promise<SourceRow | null> {
  const scope = activeTenantPredicate(`statistics change probe (${source})`);
  const args = {
    where: { ...scope, ...where },
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
  source: StatisticSource,
  cursorAt: Date,
  cursorId: string,
): Promise<boolean> {
  const row = await findSourceRow(
    source,
    { OR: [{ updatedAt: { gt: cursorAt } }, { updatedAt: cursorAt, id: { gt: cursorId } }] },
    "asc",
  );
  return row !== null;
}

/** The newest row in the table — the cursor position to record. */
function newestSourceRow(source: StatisticSource): Promise<SourceRow | null> {
  return findSourceRow(source, {}, "desc");
}

/* ─── the rollup ──────────────────────────────────────────────────────────── */

export type RollupResult = {
  /** Sources whose buckets were recomputed this run. */
  recomputed: number;
  /** Sources whose whole history was built for the first time this run. */
  backfilled: number;
  bucketsWritten: number;
  bucketsRemoved: number;
  bucketsPruned: number;
};

const EMPTY_RESULT: RollupResult = {
  recomputed: 0,
  backfilled: 0,
  bucketsWritten: 0,
  bucketsRemoved: 0,
  bucketsPruned: 0,
};

/**
 * Roll up statistics for the tenant currently in scope. Safe to run every tick,
 * safe to run twice, and correct after any number of missed ticks — a missed
 * tick just means the next one finds more changed and recomputes the same
 * window it would have anyway.
 */
export async function rollUpStatistics(now: Date = new Date()): Promise<RollupResult> {
  const tenantId = activeTenantId("statistics rollup");
  const result = { ...EMPTY_RESULT };

  const cursors = new Map(
    (await prisma.statisticCursor.findMany({
      select: { source: true, cursorAt: true, cursorId: true, backfilledAt: true },
    })).map((row) => [row.source as StatisticSource, row]),
  );

  for (const source of STATISTIC_SOURCES) {
    const cursor = cursors.get(source);
    const backfilling = !cursor?.backfilledAt;

    // THE EARLY OUT. One indexed probe, then done — on nearly every tick, for
    // nearly every tenant.
    if (!backfilling && !(await changedSince(source, cursor.cursorAt, cursor.cursorId))) continue;

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
    const newest = (await newestSourceRow(source)) ?? { id: "", updatedAt: new Date(0) };

    const today = startOfSastDay(now);
    const dayTo = addPeriods("day", today, 1);
    const dayFrom = backfilling
      ? addPeriods("day", today, -(DAY_RETENTION_DAYS - 1))
      : addPeriods("day", today, -(RECOMPUTE_WINDOW_DAYS - 1));
    // The month window is DERIVED from the day window, never chosen separately.
    // A month may only be sealed once every day inside it is sealed; deriving
    // it guarantees that instead of relying on two constants staying in step.
    const monthFrom = backfilling ? new Date(0) : startOfSastMonth(dayFrom);
    const monthTo = addPeriods("month", startOfSastMonth(now), 1);

    for (const metric of SOURCES[source].metrics) {
      const days = await aggregateFromSource(metric, "day", dayFrom, dayTo);
      const dayWrites = await applyBuckets(tenantId, metric, "day", dayFrom, dayTo, days);
      const months = backfilling
        ? await aggregateFromSource(metric, "month", monthFrom, monthTo)
        : await aggregateFromDayBuckets(metric, monthFrom, monthTo);
      const monthWrites = await applyBuckets(tenantId, metric, "month", monthFrom, monthTo, months);
      result.bucketsWritten += dayWrites.written + monthWrites.written;
      result.bucketsRemoved += dayWrites.removed + monthWrites.removed;
    }

    const id = statisticCursorId(tenantId, source);
    await prisma.statisticCursor.upsert({
      where: { id },
      create: {
        id,
        tenantId,
        source,
        cursorAt: newest.updatedAt,
        cursorId: newest.id,
        backfilledAt: now,
      },
      update: {
        cursorAt: newest.updatedAt,
        cursorId: newest.id,
        // Never re-stamped: it records when history was first built, and it is
        // what selects the backfill path. Re-stamping it would be harmless
        // today and would silently disable backfill detection if the field
        // ever gained a second reader.
        ...(backfilling ? { backfilledAt: now } : {}),
      },
    });

    result.recomputed += 1;
    if (backfilling) result.backfilled += 1;
  }

  result.bucketsPruned = await pruneDayBuckets(now);
  return result;
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
async function pruneDayBuckets(now: Date): Promise<number> {
  const cutoff = addPeriods("day", startOfSastDay(now), -DAY_RETENTION_DAYS);
  const expired = await prisma.statisticBucket.findMany({
    where: { period: "day", bucketStart: { lt: cutoff } },
    orderBy: { bucketStart: "asc" },
    take: MAX_BUCKET_DELETES_PER_SWEEP,
    select: { id: true },
  });
  if (expired.length === 0) return 0;
  const { count } = await prisma.statisticBucket.deleteMany({
    where: { id: { in: expired.map((row) => row.id) } },
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
 * Which sources have a complete bucket history.
 *
 * A reader MUST check this before trusting the buckets. Between the deploy and
 * the first cron tick there are no buckets at all, and a chart that silently
 * reads an unbuilt table shows a flat zero line — which looks like a business
 * collapse rather than a cold start. Callers fall back to the live query until
 * this says otherwise.
 */
export async function readyStatisticSources(): Promise<Set<StatisticSource>> {
  const rows = await prisma.statisticCursor.findMany({
    where: { backfilledAt: { not: null } },
    select: { source: true },
  });
  return new Set(rows.map((row) => row.source as StatisticSource));
}

/** Is every metric in `metrics` backed by a built bucket history? */
export async function statisticsReadyFor(metrics: StatisticMetric[]): Promise<boolean> {
  const ready = await readyStatisticSources();
  return metrics.every((metric) => ready.has(METRICS[metric].source));
}

/**
 * Read one metric's buckets over `[from, to)`.
 *
 * The bounded read the whole feature exists for: at most one row per bucket per
 * dimension, where the query it replaces returned one row per source record.
 */
export async function readStatisticBuckets(options: {
  metric: StatisticMetric;
  period: StatisticPeriod;
  from: Date;
  to: Date;
}): Promise<StatisticRow[]> {
  const rows = await prisma.statisticBucket.findMany({
    where: {
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
