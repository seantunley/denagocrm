/**
 * OPEN OR CLOSED — the chatbot's office hours (Chatbot page: BOT_HOURS "08:00-17:00", BOT_DAYS "1,2,3,4,5", Monday = 1)
 * and, when asked, the workspace's public holidays (lib/publicHolidays.ts). Pure: every function takes `now`.
 * Africa/Johannesburg is UTC+2 with no DST. Used by the flow builder's Opening hours step (Sean, 2026-11-02) and the
 * old auto-reply's office-hours check.
 */

const SAST_MS = 2 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** "08:00-17:00" → minutes [480, 1020]; anything unreadable is the 08:00–17:00 default. */
function parseHours(hours: string | null | undefined): [number, number] {
  const toMin = (t: string | undefined) => { const [h, m] = (t ?? "").trim().split(":").map(Number); return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN; };
  const [s, e] = (hours || "08:00-17:00").split("-");
  const start = toMin(s), end = toMin(e);
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : [480, 1020];
}

export type OpeningHours = { hours?: string | null; days?: string | null };

/** The Johannesburg date of `now`, YYYY-MM-DD. */
export function sastDateKey(now: Date): string {
  const sast = new Date(now.getTime() + SAST_MS);
  return `${sast.getUTCFullYear()}-${pad(sast.getUTCMonth() + 1)}-${pad(sast.getUTCDate())}`;
}

/** Open at `now`? Inside the hours, on one of the days, and not a holiday by `isHoliday` when it is given. */
export function isOpenAt(now: Date, setting: OpeningHours, opts: { isHoliday?: (dateKey: string) => boolean } = {}): boolean {
  const sast = new Date(now.getTime() + SAST_MS);
  const day = sast.getUTCDay() === 0 ? 7 : sast.getUTCDay();
  if (!(setting.days || "1,2,3,4,5").split(",").map((d) => d.trim()).includes(String(day))) return false;
  if (opts.isHoliday?.(sastDateKey(now))) return false;
  const minutes = sast.getUTCHours() * 60 + sast.getUTCMinutes();
  const [start, end] = parseHours(setting.hours);
  return minutes >= start && minutes < end;
}
