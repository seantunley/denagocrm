/** How long a new quote is valid for when the owner has not set QUOTE_VALID_DAYS. */
export const DEFAULT_QUOTE_VALID_DAYS = 7;

/**
 * The QUOTE_VALID_DAYS setting as a day count — the ONE reading of it. Every
 * path that dates a new quote or shows the default goes through here, so the
 * number on Settings → Quotes is the number every new quote gets.
 */
export function quoteValidDays(raw: string | null | undefined): number {
  const days = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(days) && days >= 1 ? days : DEFAULT_QUOTE_VALID_DAYS;
}

/** The fallback terms a new quote starts with when QUOTE_TERMS is unset. */
export const DEFAULT_QUOTE_TERMS = "Prices include VAT. Delivery arranged on acceptance. E&OE.";

// ── A quote's expiry is a CALENDAR DATE in the workspace's time zone ──────────
//
// "Valid until 6 Oct" means the whole of 6 October where the business is. It
// used to round-trip through UTC and the server's clock — addDays(new Date()),
// toISOString().slice(0, 10), `${date}T12:00:00` — which agrees with the
// workspace calendar only when the workspace is near UTC. At 03:30 UTC on
// 30 Sep it is still the 29th in New York and already 1 Oct in Auckland, so
// the editor's date and the printed "valid until" came out a day apart.
//
// The rule every path below follows: a date KEY is "YYYY-MM-DD" on the
// workspace calendar; the column stores it as 12:00 on that date in the
// workspace's zone; reading it back in that zone always gives the same key
// (noon is hours away from midnight under any DST shift). Rows stored before
// this read as the date they always displayed in that zone, so Johannesburg
// quotes show exactly what they showed before.

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date ("YYYY-MM-DD") an instant falls on in `timeZone`. */
export function calendarDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** A date key moved by whole days — pure calendar arithmetic, no clock involved. */
export function addCalendarDays(key: string, days: number): string {
  const [, y, m, d] = KEY.exec(key) ?? [];
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + days)).toISOString().slice(0, 10);
}

/** How far `timeZone` is ahead of UTC at `instant`, in ms. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant the column stores for date key `key`: 12:00 on that date in `timeZone`. Null for a malformed key. */
export function calendarDateInstant(key: string, timeZone: string): Date | null {
  const [, y, m, d] = KEY.exec(key) ?? [];
  if (!y) return null;
  const noonUtc = Date.UTC(Number(y), Number(m) - 1, Number(d), 12);
  if (Number.isNaN(noonUtc) || new Date(noonUtc).toISOString().slice(0, 10) !== key) return null;
  const guess = new Date(noonUtc - zoneOffsetMs(new Date(noonUtc), timeZone));
  return new Date(noonUtc - zoneOffsetMs(guess, timeZone));
}

/** A new quote's expiry: today on the workspace calendar plus `validDays`. */
export function defaultQuoteExpiry(now: Date, validDays: number, timeZone: string): Date {
  return calendarDateInstant(addCalendarDays(calendarDateIn(now, timeZone), validDays), timeZone)!;
}

/**
 * How many days THIS quote was issued valid for: calendar days from its issue
 * date to its expiry date on the workspace calendar. Taken from the quote itself,
 * never the live setting, so {{quote.validDays}} on an old quote keeps agreeing
 * with its own "valid until" date.
 */
export function quoteValidDaysOf(createdAt: Date, validUntil: Date, timeZone: string): number {
  const day = (d: Date) => Date.parse(`${calendarDateIn(d, timeZone)}T00:00:00Z`) / 86_400_000;
  return Math.round(day(validUntil) - day(createdAt));
}

/** A quote stays signable through the end of its valid-until day, on the workspace calendar. */
export function quoteExpired(validUntil: Date | null, timeZone: string, now: Date = new Date()): boolean {
  if (!validUntil) return false;
  return calendarDateIn(now, timeZone) > calendarDateIn(validUntil, timeZone);
}

/**
 * The first instant AFTER `instant`'s calendar day in `timeZone` — midnight at
 * the start of the next day there. It is the moment {@link quoteExpired} turns
 * true for a quote valid until that day, as a timestamp something else can be
 * compared against: a signing link stops working then, not at some hour of the
 * server's own clock.
 *
 * Local noon is the anchor because it exists exactly once on every calendar day
 * in every zone. Midnight is twelve hours before the next noon except on a night
 * the clocks change, when it is eleven or thirteen — hence the correction.
 */
export function endOfCalendarDay(instant: Date, timeZone: string): Date {
  const nextDay = addCalendarDays(calendarDateIn(instant, timeZone), 1);
  const HOUR = 3_600_000;
  let start = calendarDateInstant(nextDay, timeZone)!.getTime() - 12 * HOUR;
  if (calendarDateIn(new Date(start), timeZone) !== nextDay) start += HOUR;
  else if (calendarDateIn(new Date(start - 1), timeZone) === nextDay) start -= HOUR;
  return new Date(start);
}
