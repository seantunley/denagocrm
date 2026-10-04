import { z } from "zod";

/**
 * Scheduled requests — a question DAX answers on its own at a set time ("every
 * Monday at 7, which deals went quiet?"), Hermes-style natural-language cron.
 * The assistant proposes one as a card; the person confirms it; the assistant
 * cron runs it as them. This file is the pure part: what a valid schedule is,
 * when it next runs, and how it reads to a person. No server-only imports, so
 * the card, the page and the tests can all use it.
 *
 * Times are South African (UTC+02:00 all year — no daylight saving), which is
 * what people mean when they say "at 7". Stored as "HH:MM" plus a cadence rather
 * than a cron string: it is what the model emits reliably and what reads back
 * plainly on the Ask page.
 */

export const CADENCES = ["once", "daily", "weekdays", "weekly"] as const;
export type Cadence = (typeof CADENCES)[number];

/** Per person — a schedule is a ChatGPT run on the workspace's connection, every time. */
export const MAX_ACTIVE_SCHEDULES = 10;

const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A real calendar date: "2026-02-30" passes a regex but not this. */
function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * The fields, unrefined — so the assistant's proposal union can reuse them
 * (a discriminated union needs plain objects). `scheduleInput` adds the rules
 * that tie them together; everything that SAVES a schedule goes through it.
 */
export const scheduleFields = {
  question: z.string().trim().min(1).max(300),
  cadence: z.enum(CADENCES),
  weekday: z.number().int().min(0).max(6).optional(),
  timeOfDay: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  onDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate).optional(),
};

export const scheduleInput = z
  .object(scheduleFields)
  .strict()
  .superRefine((s, ctx) => {
    if ((s.cadence === "weekly") !== (s.weekday !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["weekday"], message: "A weekday goes with a weekly schedule, and only with one." });
    }
    if ((s.cadence === "once") !== (s.onDate !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["onDate"], message: "A date goes with a one-off, and only with one." });
    }
  });
export type ScheduleInput = z.infer<typeof scheduleInput>;

/** What nextRun/describeSchedule need — a saved row (nulls) or a fresh input (undefined) both fit. */
export type ScheduleTiming = {
  cadence: string;
  weekday?: number | null;
  timeOfDay: string;
  onDate?: string | null;
};

/** The instant that is HH:MM South African time on the given SA calendar day. */
function saInstant(year: number, monthIndex: number, day: number, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(":").map(Number);
  return new Date(Date.UTC(year, monthIndex, day, h, m) - SA_OFFSET_MS);
}

/**
 * When it next runs: the first occurrence STRICTLY after `after` (so a run that
 * has just fired never schedules itself for the same instant again). A one-off
 * whose time has passed → null. Unknown or broken timing → null too, which the
 * runner treats as "switch it off" rather than guessing.
 *
 * Missed runs are never made up: the runner asks for the next one after NOW,
 * so a schedule that was due while the cron was down simply runs next time.
 */
export function nextRun(s: ScheduleTiming, after: Date): Date | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.timeOfDay)) return null;
  if (s.cadence === "once") {
    if (!s.onDate || !/^\d{4}-\d{2}-\d{2}$/.test(s.onDate) || !isCalendarDate(s.onDate)) return null;
    const [y, m, d] = s.onDate.split("-").map(Number);
    const at = saInstant(y, m - 1, d, s.timeOfDay);
    return at.getTime() > after.getTime() ? at : null;
  }
  if (s.cadence === "weekly" && (s.weekday == null || s.weekday < 0 || s.weekday > 6)) return null;
  if (!["daily", "weekdays", "weekly"].includes(s.cadence)) return null;
  // Today in South Africa, then up to a week ahead: Date.UTC rolls the day over
  // months and years for us. Day 0's time may already have passed; day 7 is
  // there for a weekly whose day is today but whose time has gone.
  const local = new Date(after.getTime() + SA_OFFSET_MS);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + ahead));
    const weekday = day.getUTCDay();
    if (s.cadence === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (s.cadence === "weekly" && weekday !== s.weekday) continue;
    const at = saInstant(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), s.timeOfDay);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/** How it reads: "Every Monday at 07:00", "Weekdays at 08:30", "Once on Fri 10 Oct at 09:00". */
export function describeSchedule(s: ScheduleTiming): string {
  const at = `at ${s.timeOfDay}`;
  switch (s.cadence) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Weekdays ${at}`;
    case "weekly":
      return `Every ${DAYS[s.weekday ?? 0]} ${at}`;
    default: {
      const [y, m, d] = (s.onDate ?? "").split("-").map(Number);
      const day = new Date(Date.UTC(y, m - 1, d));
      if (Number.isNaN(day.getTime())) return `Once ${at}`;
      return `Once on ${DAYS[day.getUTCDay()].slice(0, 3)} ${d} ${MONTHS[m - 1]} ${at}`;
    }
  }
}

/**
 * The answer saved when a scheduled question couldn't run, so the person sees
 * why instead of silence. General terms only: askCrm's error may carry a
 * technical reason from ChatGPT, and that isn't for the thread.
 */
export function scheduleFailureNote(error: string): string {
  if (/connect chatgpt/i.test(error)) {
    return "I couldn't run this scheduled question: ChatGPT isn't connected for this workspace (Settings → Integrations → ChatGPT).";
  }
  return "I couldn't run this scheduled question just now — ChatGPT didn't give me an answer. You can ask it yourself now.";
}
