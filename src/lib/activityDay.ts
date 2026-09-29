/**
 * "Has this activity's day arrived yet?", in the business timezone.
 *
 * Deliberately a DAY question, not an instant one. A 15:00 call can be made at
 * 14:40 and ticked off — the rep is not going to wait for the minute — so the
 * rule is the one a person would state: you cannot complete work on a day that
 * has not started. Comparing instants would refuse that legitimate early tick.
 *
 * Africa/Johannesburg, because that is the timezone every displayed date in this
 * app is pinned to (lib/format.ts). Using the server's local day would put the
 * boundary two hours early on Vercel, where the process runs in UTC: between
 * 00:00 and 02:00 SAST the server is still on "yesterday", so tomorrow's work
 * would briefly look completable and today's would not.
 *
 * No `server-only` marker: the same rule has to run in the browser to decide
 * whether to OFFER the control, and a guard that cannot be imported by the UI
 * gets reimplemented there instead — which is how the two drift apart.
 */

const SA_TZ = "Africa/Johannesburg";

/**
 * The Johannesburg calendar date of an instant, as `YYYY-MM-DD`.
 *
 * `en-CA` because it formats as ISO-like `YYYY-MM-DD`, which makes the values
 * lexicographically comparable — `"2026-09-15" > "2026-09-14"` is exactly the
 * question being asked, with no Date arithmetic and no DST edge cases.
 */
export function johannesburgDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** True when `dueDate` falls on a LATER Johannesburg day than `now`. */
export function isFutureDay(dueDate: Date, now: Date = new Date()): boolean {
  return johannesburgDateKey(dueDate) > johannesburgDateKey(now);
}

/**
 * The refusal text, in one place so the server guard and any UI hint agree.
 * Names the date, because "not yet" without "until when" is a dead end.
 */
export function futureActivityRefusal(dueDate: Date): string {
  const day = dueDate.toLocaleDateString("en-ZA", {
    timeZone: SA_TZ,
    day: "numeric",
    month: "long",
  });
  return `This is scheduled for ${day}. You can complete it on the day, not before.`;
}
