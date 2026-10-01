import { formatDistanceToNow } from "date-fns";

/** "2 hours ago" — for a byline where the exact timestamp is secondary. */
export function formatRelativeTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * A workspace's money and time conventions: the VAT rate a NEW quote line is
 * charged at, the currency amounts are in, the locale that decides how numbers
 * and dates read, and the time zone dates are shown in. Owner-editable under
 * Settings → Quotes; read server-side by `getRegionalSettings()` (settings.ts).
 *
 * The defaults ARE the behaviour from before these were settings, so a
 * workspace that never opens the screen renders byte-for-byte as it did.
 *
 * VAT here is only the rate NEW lines start at. An issued quote's lines carry
 * their own `taxRatePct` (QuoteItem/QuoteFee), so changing this never
 * re-prices a document that already exists.
 */
export type Regional = {
  vatRatePct: number;
  currency: string;
  locale: string;
  timeZone: string;
};

export const DEFAULT_REGIONAL: Readonly<Regional> = Object.freeze({
  vatRatePct: 15,
  currency: "ZAR",
  locale: "en-ZA",
  timeZone: "Africa/Johannesburg",
});

function intlAccepts(make: () => unknown): boolean {
  try {
    make();
    return true;
  } catch {
    return false;
  }
}

/**
 * Stored setting strings → a Regional that is safe to format with. Each field
 * falls back to its default on its own when blank or not something Intl
 * accepts, so a bad value can never throw inside a PDF render.
 */
export function regionalFrom(raw: Partial<Record<keyof Regional, string | null | undefined>>): Regional {
  const vatText = String(raw.vatRatePct ?? "").trim().replace(",", ".");
  const vat = Number(vatText);
  const currency = String(raw.currency ?? "").trim().toUpperCase();
  const locale = String(raw.locale ?? "").trim();
  const timeZone = String(raw.timeZone ?? "").trim();
  return {
    vatRatePct: vatText && Number.isFinite(vat) && vat >= 0 && vat <= 100 ? vat : DEFAULT_REGIONAL.vatRatePct,
    currency: /^[A-Z]{3}$/.test(currency) && intlAccepts(() => new Intl.NumberFormat("en", { style: "currency", currency }))
      ? currency
      : DEFAULT_REGIONAL.currency,
    locale: locale && intlAccepts(() => new Intl.NumberFormat(locale)) ? locale : DEFAULT_REGIONAL.locale,
    timeZone: timeZone && intlAccepts(() => new Intl.DateTimeFormat("en", { timeZone })) ? timeZone : DEFAULT_REGIONAL.timeZone,
  };
}

type MoneyFormat = Pick<Regional, "currency" | "locale">;
type DateFormat = Pick<Regional, "locale" | "timeZone">;

/** Due date, with the time when one was set (midnight = date-only). */
export function formatDue(d: Date, r: DateFormat = DEFAULT_REGIONAL): string {
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  return hasTime ? formatDateTime(d, r) : formatDate(d, r);
}

/** Compact money for tight stat cards: R 370k, R 2,27m. */
export function formatZARCompact(cents: number, m: MoneyFormat = DEFAULT_REGIONAL): string {
  const r = cents / 100;
  if (r < 100_000) return formatZAR(cents, m);
  const parts = new Intl.NumberFormat(m.locale, { style: "currency", currency: m.currency }).formatToParts(1.5);
  const symbol = parts.find((p) => p.type === "currency")?.value ?? m.currency;
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  if (r >= 1_000_000) return `${symbol} ${(r / 1_000_000).toFixed(2).replace(".", decimal)}m`;
  return `${symbol} ${Math.round(r / 1000)}k`;
}

/**
 * Money in the workspace's currency. The name predates the currency setting;
 * without `m` it is exactly the rand formatting it always was.
 */
export function formatZAR(cents: number, m: MoneyFormat = DEFAULT_REGIONAL): string {
  return new Intl.NumberFormat(m.locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// Servers run in UTC, so every displayed time MUST be pinned to the workspace's
// time zone — otherwise stored UTC prints two hours early in Johannesburg
// (10:00 shows as 08:00). Without an explicit format that zone is the default.
const SA_TZ = DEFAULT_REGIONAL.timeZone;

export function formatDate(d: Date | string | null | undefined, r: DateFormat = DEFAULT_REGIONAL): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString(r.locale, {
    timeZone: r.timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(d: Date | string | null | undefined, r: DateFormat = DEFAULT_REGIONAL): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(r.locale, {
    timeZone: r.timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The parts of an instant, as they read in Johannesburg. */
function saParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: SA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  // hourCycle h23 vs h24: some ICU builds render midnight as "24" with hour12
  // false, which would produce an invalid 24:00 in an input.
  if (out.hour === "24") out.hour = "00";
  return out;
}

/**
 * The value for an `<input type="datetime-local">`, in Johannesburg time.
 *
 * THE RULE AT THE TOP OF THIS FILE APPLIES TO FORM FIELDS TOO, and that is
 * exactly where it was being broken. Both test-drive pages built their value
 * with date-fns `format(date, "yyyy-MM-dd'T'HH:mm")`, which formats in the
 * SERVER's timezone — UTC on Vercel. So a booking saved for 10:00 displayed
 * "10:00" in the summary tile (formatDateTime, correctly pinned) and "08:00" in
 * the field beneath it. It reads like the form has reset itself to a default.
 *
 * The damage is not the display. `localDateTime` in app/actions/testDrives.ts
 * parses a submitted value as +02:00, so re-saving that form without touching
 * the time takes the 08:00 it was shown, reads it as 08:00 SAST, and stores a
 * booking two hours earlier than the one that was there. Every save walks the
 * appointment backwards.
 *
 * Returns "" for null so it can seed an optional field directly.
 */
export function inputDateTimeValue(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const p = saParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * The value for an `<input type="date">`, in Johannesburg time.
 *
 * Same fault, quieter: a date-only field formatted in UTC shows the PREVIOUS
 * day for any instant stored between midnight and 02:00 SAST.
 */
export function inputDateValue(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const p = saParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function contactName(c: {
  firstName: string;
  lastName?: string | null;
  company?: string | null;
  isCompany?: boolean;
}): string {
  if (c.isCompany && c.company) return c.company;
  return [c.firstName, c.lastName].filter(Boolean).join(" ");
}

export function parseRands(input: string | null | undefined): number {
  if (!input) return 0;
  const n = parseFloat(String(input).replace(/[^\d.-]/g, ""));
  if (isNaN(n)) return 0;
  return Math.round(n * 100);
}
