/**
 * PUBLIC HOLIDAYS, PER WORKSPACE (Sean, 2026-11-02: "Those public holidays lists needs to be available somewhere with
 * the ability to add other countries"). Settings → Public holidays.
 *
 * South Africa is built in (the Public Holidays Act's rules, Easter included) and needs nothing loaded. Any other
 * country's holidays are loaded from a public holiday calendar when the owner picks it, and stored here per year.
 * The workspace's own closed days (a shutdown, a stocktake) are added on top, whatever the country. Pure.
 */

export const PUBLIC_HOLIDAYS_KEY = "PUBLIC_HOLIDAYS";
export type Holiday = { date: string; name: string };
/** `skipped`: dates of the country's holidays the workspace does not close for (a regional one, say). */
export type HolidaySetting = { country: string; countryName: string; loaded: Record<string, Holiday[]>; custom: Holiday[]; skipped: string[] };
export const DEFAULT_HOLIDAYS: HolidaySetting = { country: "ZA", countryName: "South Africa", loaded: {}, custom: [], skipped: [] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Easter Sunday (Gregorian, the anonymous algorithm), as [month, day]. */
function easter(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

/**
 * South Africa's public holidays for a year, date → name (Public Holidays Act 36 of 1994): the fixed ones, Good
 * Friday and Family Day from Easter, and a holiday on a Sunday makes the Monday after it one too.
 */
export function saPublicHolidays(year: number): Map<string, string> {
  const days: [number, number, string][] = [
    [1, 1, "New Year's Day"], [3, 21, "Human Rights Day"], [4, 27, "Freedom Day"], [5, 1, "Workers' Day"],
    [6, 16, "Youth Day"], [8, 9, "National Women's Day"], [9, 24, "Heritage Day"], [12, 16, "Day of Reconciliation"],
    [12, 25, "Christmas Day"], [12, 26, "Day of Goodwill"],
  ];
  const [em, ed] = easter(year);
  const at = (offset: number) => { const d = new Date(Date.UTC(year, em - 1, ed + offset)); return [d.getUTCMonth() + 1, d.getUTCDate()] as const; };
  const gf = at(-2), fd = at(1);
  days.push([gf[0], gf[1], "Good Friday"], [fd[0], fd[1], "Family Day"]);
  const out = new Map<string, string>();
  for (const [m, d, name] of days) out.set(key(year, m, d), name);
  for (const [m, d, name] of days) {
    if (new Date(Date.UTC(year, m - 1, d)).getUTCDay() !== 0) continue;
    const monday = new Date(Date.UTC(year, m - 1, d + 1));
    const k = key(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
    if (!out.has(k)) out.set(k, `${name} (observed)`);
  }
  return out;
}

const cleanList = (value: unknown): Holiday[] =>
  (Array.isArray(value) ? value : [])
    .filter((h): h is Holiday => Boolean(h) && typeof h.date === "string" && DATE.test(h.date) && typeof h.name === "string")
    .map((h) => ({ date: h.date, name: h.name.trim().slice(0, 80) || "Holiday" }))
    .slice(0, 200);

/** The saved setting, or the default — anything malformed dropped, never thrown on. */
export function parseHolidaySetting(raw: string | null | undefined): HolidaySetting {
  try {
    const v = JSON.parse(raw ?? "");
    if (!v || typeof v !== "object" || typeof v.country !== "string" || !/^[A-Z]{2}$/.test(v.country)) return DEFAULT_HOLIDAYS;
    const loaded: Record<string, Holiday[]> = {};
    for (const [year, list] of Object.entries(v.loaded ?? {})) if (/^\d{4}$/.test(year)) loaded[year] = cleanList(list);
    const skipped = (Array.isArray(v.skipped) ? v.skipped : []).filter((d: unknown): d is string => typeof d === "string" && DATE.test(d)).slice(0, 200);
    return { country: v.country, countryName: String(v.countryName ?? v.country).slice(0, 80), loaded, custom: cleanList(v.custom), skipped };
  } catch {
    return DEFAULT_HOLIDAYS;
  }
}

/**
 * A year's holidays: the country's (built in for South Africa, else as loaded) and the workspace's own, by date —
 * each country one marked `skipped` when the workspace does not close for it.
 */
export function holidaysFor(setting: HolidaySetting, year: number): (Holiday & { custom?: true; skipped?: true })[] {
  const country: Holiday[] = setting.country === "ZA"
    ? [...saPublicHolidays(year)].map(([date, name]) => ({ date, name }))
    : setting.loaded[String(year)] ?? [];
  const own = setting.custom.filter((h) => h.date.startsWith(`${year}-`)).map((h) => ({ ...h, custom: true as const }));
  return [
    ...country.map((h) => (setting.skipped.includes(h.date) ? { ...h, skipped: true as const } : h)),
    ...own,
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/** Is this Johannesburg date (YYYY-MM-DD) a holiday (not skipped) or one of the workspace's closed days? */
export function isHoliday(setting: HolidaySetting, dateKey: string): boolean {
  return holidaysFor(setting, Number(dateKey.slice(0, 4))).some((h) => h.date === dateKey && !h.skipped);
}

/** Another country's year not loaded yet (South Africa never needs loading). */
export function missingYears(setting: HolidaySetting, years: number[]): number[] {
  return setting.country === "ZA" ? [] : years.filter((year) => !setting.loaded[String(year)]);
}
