import { getSetting, putSetting } from "./settings";
import {
  clampHour,
  DEFAULT_NEXT_STEP_HOUR,
  DEFAULT_NEXT_STEP_SKIP_WEEKENDS,
  type NextStepScheduling,
} from "./businessHours";

export const NEXT_STEP_HOUR_KEY = "NEXT_STEP_HOUR";
export const NEXT_STEP_SKIP_WEEKENDS_KEY = "NEXT_STEP_SKIP_WEEKENDS";

/**
 * Reads the next-step scheduling config from AppSettings. Unset keys fall back
 * to sensible defaults (09:00, skip weekends) so behaviour is well-defined on a
 * fresh install with no configuration.
 */
export async function getNextStepScheduling(): Promise<NextStepScheduling> {
  const [hourRaw, skipRaw] = await Promise.all([
    getSetting(NEXT_STEP_HOUR_KEY),
    getSetting(NEXT_STEP_SKIP_WEEKENDS_KEY),
  ]);

  const hour =
    hourRaw == null || hourRaw.trim() === ""
      ? DEFAULT_NEXT_STEP_HOUR
      : clampHour(parseInt(hourRaw, 10));

  const skipWeekends =
    skipRaw == null || skipRaw.trim() === ""
      ? DEFAULT_NEXT_STEP_SKIP_WEEKENDS
      : skipRaw === "true";

  return { hour, skipWeekends };
}

/** Persists the next-step scheduling config to AppSettings. */
export async function setNextStepScheduling(
  opts: NextStepScheduling
): Promise<void> {
  await putSetting(NEXT_STEP_HOUR_KEY, String(clampHour(opts.hour)));
  await putSetting(
    NEXT_STEP_SKIP_WEEKENDS_KEY,
    opts.skipWeekends ? "true" : "false"
  );
}
