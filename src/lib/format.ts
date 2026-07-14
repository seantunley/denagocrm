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
