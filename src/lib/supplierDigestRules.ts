/**
 * The weekly supplier-papers digest to the workspace owner (review section E, 2026-11-09): which supplier quotes,
 * invoices and proofs of payment are still missing on deals in progress. Pure — when it is due, and what it says.
 */

export const SUPPLIER_DIGEST_SWITCH = "SUPPLIER_DIGEST";
/** The ISO week it last went, so a 30-minute cron sends it once a week. */
export const SUPPLIER_DIGEST_LAST_WEEK = "SUPPLIER_DIGEST_LAST_WEEK";
/** Monday, from this hour in the workspace's own time zone. */
export const DIGEST_HOUR = 7;

/** The workspace-local calendar parts of an instant. */
export function localParts(now: Date, timeZone: string): { year: number; month: number; day: number; weekday: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday, hour: Number(parts.hour) };
}

/** ISO-8601 week of a local calendar day, e.g. "2026-W46". */
export function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday); // the Thursday of this week decides its year
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Due from 07:00 on Monday (local) until it has gone this week; a missed Monday catches up later in the week. */
export function digestWeekDue(now: Date, timeZone: string, lastWeek: string | null): string | null {
  const local = localParts(now, timeZone);
  const week = isoWeekKey(local.year, local.month, local.day);
  if (week === lastWeek) return null;
  if (local.weekday === 1 && local.hour < DIGEST_HOUR) return null;
  return week;
}

export type DigestDeal = { quoteNumber: number; customer: string; href: string; missing: string[] };

/** The email: deals with what is still missing from which supplier — or nothing to send when there is none. */
export function supplierDigestEmail(input: { brand: string; origin: string; deals: DigestDeal[] }): { subject: string; text: string } | null {
  const deals = input.deals.filter((deal) => deal.missing.length > 0);
  if (deals.length === 0) return null;
  const papers = deals.reduce((sum, deal) => sum + deal.missing.length, 0);
  const lines = deals.flatMap((deal) => [
    `Q-${deal.quoteNumber} · ${deal.customer}`,
    ...deal.missing.map((item) => `  - ${item}`),
    `  ${input.origin}${deal.href}`,
    "",
  ]);
  return {
    subject: `${input.brand}: ${papers} supplier paper${papers === 1 ? "" : "s"} missing on ${deals.length} deal${deals.length === 1 ? "" : "s"}`,
    text: [
      "Supplier papers still missing on deals in progress:",
      "",
      ...lines,
      "Ask a supplier for a paper from the deal's file. Switch this weekly email off in Settings → Automatic jobs & messages.",
    ].join("\n"),
  };
}

/**
 * Every row, one page at a time: `page(after)` returns up to `size` rows with ids after `after` (in id order),
 * each page goes to `visit`, and paging stops at the first short page. Bounded memory, no row left out.
 */
export async function eachPage<T extends { id: string }>(
  size: number,
  page: (after: string | null) => Promise<T[]>,
  visit: (rows: T[]) => Promise<void> | void,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows = await page(after);
    if (rows.length) await visit(rows);
    if (rows.length < size) return;
    after = rows[rows.length - 1].id;
  }
}
