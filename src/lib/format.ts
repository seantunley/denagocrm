/** Due date, with the time when one was set (midnight = date-only). */
export function formatDue(d: Date): string {
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  return hasTime ? formatDateTime(d) : formatDate(d);
}

/** Compact money for tight stat cards: R 370k, R 2,27m. */
export function formatZARCompact(cents: number): string {
  const r = cents / 100;
  if (r >= 1_000_000) return `R ${(r / 1_000_000).toFixed(2).replace(".", ",")}m`;
  if (r >= 100_000) return `R ${Math.round(r / 1000)}k`;
  return formatZAR(cents);
}

export function formatZAR(cents: number): string {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// The app serves one business in South Africa (UTC+2). Servers run in UTC, so
// every displayed time MUST be pinned to Africa/Johannesburg — otherwise stored
// UTC prints two hours early (10:00 shows as 08:00).
const SA_TZ = "Africa/Johannesburg";

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-ZA", {
    timeZone: SA_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-ZA", {
    timeZone: SA_TZ,
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
