export interface NextStepScheduling {
  /**
   * Hour of the day (0–23) that auto-created follow-up tasks are due, expressed
   * in Africa/Johannesburg (SAST, UTC+2, no DST) — the timezone the app both
   * displays and schedules business hours in.
   */
  hour: number;
  /** When true, a due date that lands on Sat/Sun rolls forward to Monday. */
  skipWeekends: boolean;
}

/** Africa/Johannesburg is a fixed UTC+2 with no daylight saving. */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

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
 * Compute when an auto-created follow-up task should be due, in Africa/
 * Johannesburg (SAST, UTC+2) — the timezone the app schedules and renders in.
 *
 * Takes the base moment's SAST calendar day, adds `days` calendar days, then
 * returns a Date whose SAST wall-clock time is `opts.hour:00:00` — so a lead
 * created at 23:09 SAST gets a task due at 09:00 SAST the next day, and a
 * configured 09:00 lands at 07:00Z (which renders as 09:00 SAST), never 11:00.
 * When `skipWeekends` is set and the SAST result day is a Saturday or Sunday,
 * it rolls forward to the following Monday (keeping the same SAST hour).
 *
 * Pure: it never reads the clock — always pass `base` explicitly.
 */
export function nextStepDueDate(
  base: Date,
  days: number,
  opts: NextStepScheduling
): Date {
  const hour = clampHour(opts.hour);
  // Shift into SAST so reading the UTC fields yields SAST wall-clock parts.
  const sast = new Date(base.getTime() + SAST_OFFSET_MS);
  // Anchor to the SAST calendar day, then do calendar arithmetic in UTC to
  // stay free of the server's local timezone and any DST assumptions.
  const day = new Date(
    Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate())
  );
  day.setUTCDate(day.getUTCDate() + days);
  if (opts.skipWeekends) {
    const dow = day.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow === 6) day.setUTCDate(day.getUTCDate() + 2);
    else if (dow === 0) day.setUTCDate(day.getUTCDate() + 1);
  }
  const yyyy = day.getUTCFullYear();
  const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(day.getUTCDate()).padStart(2, "0");
  const HH = String(hour).padStart(2, "0");
  // Build from an explicit +02:00 offset so the moment is fixed regardless of
  // where the code runs (see moveLeadToTestDrive in src/app/actions/leads.ts).
  return new Date(`${yyyy}-${mm}-${dd}T${HH}:00:00+02:00`);
}
