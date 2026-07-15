import "server-only";
import { getSetting } from "@/lib/settings";
import { DEFAULT_LABOUR_RATE_CENTS, hoursBetween } from "@/lib/workshop-constants";

export const LABOUR_RATE_SETTING = "WORKSHOP_LABOUR_RATE_CENTS";

/** Workshop-wide default labour rate (cents/hour) from settings, or the fallback. */
export async function getDefaultLabourRateCents(): Promise<number> {
  const raw = await getSetting(LABOUR_RATE_SETTING);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LABOUR_RATE_CENTS;
}

/** The rate a specific job bills at: its override, else the workshop default. */
export function effectiveLabourRateCents(jobLabourRateCents: number | null, defaultCents: number): number {
  return jobLabourRateCents != null && jobLabourRateCents > 0 ? jobLabourRateCents : defaultCents;
}

type TimeEntry = { startedAt: Date; endedAt: Date | null };

/** Total logged hours across time entries; the running entry counts up to `now`. */
export function totalLoggedHours(entries: TimeEntry[], now: Date): number {
  const sum = entries.reduce(
    (acc, e) => acc + hoursBetween(e.startedAt, e.endedAt ?? now),
    0,
  );
  return Math.round(sum * 100) / 100;
}
