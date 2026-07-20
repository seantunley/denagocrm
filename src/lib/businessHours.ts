import {
  addDays,
  getDay,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
} from "date-fns";

export interface NextStepScheduling {
  /** Hour of the day (0–23, local) that auto-created follow-up tasks are due. */
  hour: number;
  /** When true, a due date that lands on Sat/Sun rolls forward to Monday. */
  skipWeekends: boolean;
}

export const DEFAULT_NEXT_STEP_HOUR = 9;
export const DEFAULT_NEXT_STEP_SKIP_WEEKENDS = true;

/** Coerce any input into a valid 0–23 hour, falling back to the 09:00 default. */
export function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return DEFAULT_NEXT_STEP_HOUR;
  const whole = Math.trunc(hour);
  if (whole < 0) return 0;
  if (whole > 23) return 23;
  return whole;
}

/**
 * Compute when an auto-created follow-up task should be due.
 *
 * Returns `addDays(base, days)` with the time-of-day normalised to
 * `opts.hour:00:00.000` in local time — so a lead created at 23:09 gets a task
 * due at 09:00 the next day, not 23:09. When `skipWeekends` is set and the
 * result lands on a Saturday or Sunday, it rolls forward to the following
 * Monday (keeping the same normalised hour).
 *
 * Pure: it never reads the clock — always pass `base` explicitly.
 */
export function nextStepDueDate(
  base: Date,
  days: number,
  opts: NextStepScheduling
): Date {
  const hour = clampHour(opts.hour);
  let due = addDays(base, days);
  due = setMilliseconds(setSeconds(setMinutes(setHours(due, hour), 0), 0), 0);
  if (opts.skipWeekends) {
    const dow = getDay(due); // 0 = Sunday, 6 = Saturday
    if (dow === 6) due = addDays(due, 2);
    else if (dow === 0) due = addDays(due, 1);
  }
  return due;
}
