/**
 * Customer birthdays — the pure half. A birthday is a day and a month, with the year when it's known (for the age).
 * Kept as three numbers on Contact, so "whose birthday is today" is an index lookup, not a date calculation per row.
 * Days are South African calendar days.
 */

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type Birthday = { birthDay: number | null; birthMonth: number | null; birthYear: number | null };
export type MonthDay = { month: number; day: number };

const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * What the form sent → a birthday, or an error to show. Day and month together or neither; the year is optional,
 * and when given must be a real past year that makes the date real (29 February only in a leap year).
 */
export function parseBirthday(raw: { day?: unknown; month?: unknown; year?: unknown }, now = new Date()): { ok: true; value: Birthday } | { ok: false; error: string } {
  const num = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s === "" ? null : Number(s);
  };
  const day = num(raw.day);
  const month = num(raw.month);
  const year = num(raw.year);
  if (day === null && month === null) {
    return year === null ? { ok: true, value: { birthDay: null, birthMonth: null, birthYear: null } } : { ok: false, error: "Choose the day and month of the birthday, not only the year." };
  }
  if (day === null || month === null) return { ok: false, error: "Choose both the day and the month of the birthday." };
  if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: "Choose a month for the birthday." };
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN[month - 1]) return { ok: false, error: `${MONTHS[month - 1]} has no day ${day}.` };
  if (year !== null) {
    if (!Number.isInteger(year) || year < 1900 || year > now.getFullYear()) return { ok: false, error: "The birth year must be between 1900 and this year." };
    if (month === 2 && day === 29 && !isLeap(year)) return { ok: false, error: `${year} wasn't a leap year, so there was no 29 February.` };
  }
  return { ok: true, value: { birthDay: day, birthMonth: month, birthYear: year } };
}

/** Today's date in South Africa, as month and day (and year). */
export function saDate(at: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * The month/days whose birthdays fall on these calendar days. A 29 February birthday is celebrated on 28 February in a
 * year without one — so on 28 February of a common year, both are included.
 */
export function birthdayKeys(days: readonly { year: number; month: number; day: number }[]): MonthDay[] {
  const out: MonthDay[] = [];
  for (const d of days) {
    out.push({ month: d.month, day: d.day });
    if (d.month === 2 && d.day === 28 && !isLeap(d.year)) out.push({ month: 2, day: 29 });
  }
  return out;
}

/** The next `count` South African calendar days, starting `from` days after today (0 = today). */
export function nextDays(count: number, from = 0, at: Date = new Date()): { year: number; month: number; day: number }[] {
  const today = saDate(at);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(base + (from + i) * 86_400_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  });
}

/** "12 March", or "12 March 1984". */
export function formatBirthday(b: Birthday): string | null {
  if (!b.birthDay || !b.birthMonth) return null;
  return `${b.birthDay} ${MONTHS[b.birthMonth - 1]}${b.birthYear ? ` ${b.birthYear}` : ""}`;
}

/** The age they turn on their birthday this year (null without a year). */
export function turningAge(b: Birthday, year: number): number | null {
  return b.birthYear ? year - b.birthYear : null;
}
