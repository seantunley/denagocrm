/**
 * Bucket boundaries for reporting statistics — Africa/Johannesburg days and
 * months, expressed as UTC instants.
 *
 * "PER DAY" IS MEANINGLESS WITHOUT A TIMEZONE, and this app already picked one.
 * `src/lib/format.ts` pins every displayed timestamp to Africa/Johannesburg
 * because the servers run in UTC and stored times otherwise print two hours
 * early. `src/lib/calendarDates.ts` goes further and hard-codes the offset as
 * the literal string "+02:00" for the calendar grid. This file is the third
 * user of that decision and matches the second one exactly.
 *
 * A FIXED OFFSET, not a timezone database lookup. South Africa has observed no
 * daylight saving since 1944 and has no plans to; SAST is UTC+2, always. That
 * makes bucket boundaries pure arithmetic — no Intl formatting on the hot path,
 * no `date-fns-tz` dependency, and — the part that actually matters — the same
 * rule is expressible in SQL as `+ INTERVAL '2 hours'`, so the Postgres rollup
 * and this TypeScript agree by construction rather than by hoping two
 * timezone implementations round the same way. If South Africa ever adopts DST,
 * this constant and the SQL interval in statistics.ts change together, and the
 * existing sealed buckets stay on the old rule — which is correct, because that
 * is what they were computed under.
 *
 * WHAT THIS REPLACES. The Reports page bucketed with raw millisecond arithmetic
 * and a step of 30.44 days for ranges over four months — a "month" that is not
 * any month, drifting a little further out of alignment with the calendar at
 * every step, labelled with a bare date-fns `format()` that renders in the
 * SERVER's zone. So the twelve-month chart's bars did not correspond to months
 * and their labels could name the wrong one. Everything here is calendar-exact.
 *
 * Deliberately NOT "server-only": pure arithmetic over Date, no DB, no secrets.
 * Marking it server-only would make the boundary rule — the thing most worth
 * testing — untestable in the unit runner.
 */

/** SAST is UTC+2, with no daylight saving. See the note above. */
export const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** The two rungs of the downsampling ladder. */
export type StatisticPeriod = "day" | "month";

/**
 * Shift an instant so its UTC calendar fields read as SAST wall-clock fields.
 * Only ever used between `shift` and its inverse below — a shifted Date is not
 * a real instant and must not escape this module.
 */
const toWallClock = (instant: Date): Date => new Date(instant.getTime() + SAST_OFFSET_MS);

/** First instant of the SAST day containing `instant`. */
export function startOfSastDay(instant: Date): Date {
  const wall = toWallClock(instant);
  return new Date(
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - SAST_OFFSET_MS,
  );
}

/** First instant of the SAST month containing `instant`. */
export function startOfSastMonth(instant: Date): Date {
  const wall = toWallClock(instant);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1) - SAST_OFFSET_MS);
}

/** First instant of the `period` bucket containing `instant`. */
export function startOfPeriod(period: StatisticPeriod, instant: Date): Date {
  return period === "day" ? startOfSastDay(instant) : startOfSastMonth(instant);
}

/**
 * Move `count` buckets forward from a bucket start.
 *
 * Calendar arithmetic, not addition of a fixed span: months are 28–31 days and
 * `bucketStart + 30 days` is a different month roughly every other time.
 */
export function addPeriods(period: StatisticPeriod, bucketStart: Date, count: number): Date {
  const wall = toWallClock(bucketStart);
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  const day = wall.getUTCDate();
  const shifted =
    period === "day"
      ? Date.UTC(year, month, day + count)
      : Date.UTC(year, month + count, 1);
  return new Date(shifted - SAST_OFFSET_MS);
}

/**
 * Every bucket start in `[from, to)`, oldest first.
 *
 * The first bucket is the one CONTAINING `from`, so a range starting mid-day
 * still names the day it starts in — which is what the chart axis needs, and
 * what a bucket table can actually answer with.
 */
export function periodStarts(period: StatisticPeriod, from: Date, to: Date): Date[] {
  const starts: Date[] = [];
  let cursor = startOfPeriod(period, from);
  // Guard against a reversed or degenerate range rather than looping forever.
  while (cursor.getTime() < to.getTime()) {
    starts.push(cursor);
    cursor = addPeriods(period, cursor, 1);
  }
  return starts;
}

/** `YYYY-MM-DD` for the SAST day containing `instant`. */
export function sastDayKey(instant: Date): string {
  return toWallClock(instant).toISOString().slice(0, 10);
}

/** `YYYY-MM` for the SAST month containing `instant`. */
export function sastMonthKey(instant: Date): string {
  return toWallClock(instant).toISOString().slice(0, 7);
}

/**
 * Which rung of the ladder should answer a range of this length.
 *
 * The whole point of downsampling: a twelve-month view reads twelve month
 * buckets, not three hundred and sixty-five day buckets. The threshold is 120
 * days because that is where the Reports page itself already switches its axis
 * from day labels to month labels — below it a reader wants days, above it they
 * are looking at months whatever the underlying rows are.
 */
export const MONTHLY_READ_THRESHOLD_DAYS = 120;

export function periodForRange(from: Date, to: Date): StatisticPeriod {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return days > MONTHLY_READ_THRESHOLD_DAYS ? "month" : "day";
}

/**
 * The axis label for a bucket — "4 Aug" for a day, "Aug 26" for a month.
 *
 * Formatted IN Africa/Johannesburg, which is the whole point. The Reports page
 * labelled its buckets with a bare date-fns `format()`, which renders in the
 * server's zone — UTC on Vercel — so a bucket starting at SAST midnight is
 * 22:00 the previous day in UTC and the label named the day BEFORE the one the
 * bar counted. The bug is invisible in local development, where the server's
 * zone happens to be the reader's.
 */
export function sastBucketLabel(period: StatisticPeriod, bucketStart: Date): string {
  return bucketStart.toLocaleDateString(
    "en-ZA",
    period === "day"
      ? { timeZone: "Africa/Johannesburg", day: "numeric", month: "short" }
      : { timeZone: "Africa/Johannesburg", month: "short", year: "2-digit" },
  );
}
