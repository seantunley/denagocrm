/**
 * The weekly "unusual activity" email to the workspace owner (2026-11-23): what
 * changed that nobody asked about. Pure — what counts as unusual, and what the
 * email says. The queries and the sending are in lib/anomalyDigest.ts.
 *
 * NO AI IS INVOLVED. Each check is a plain comparison of a recent window with
 * the workspace's own earlier numbers, so every line in the email can be
 * explained by the two figures printed beside it. That is deliberate: an alert
 * about a named person or a product has to be checkable by the reader.
 *
 * THE BAR IS HIGH ON PURPOSE. A digest that cries wolf is switched off within a
 * month. Each check needs a minimum amount of data in BOTH windows, a relative
 * jump AND an absolute one, and stays silent otherwise — a quiet week sends no
 * email at all.
 *
 * WHAT A LINE IS NOT: a verdict. "Twice as many claims" may be a bad batch or a
 * good month of sales; "slower replies" may be a week of leave. The email says
 * what moved and leaves the why to the owner.
 */

export const ANOMALY_DIGEST_SWITCH = "ANOMALY_DIGEST";
/** The ISO week it last went, so a 30-minute cron sends it once a week. */
export const ANOMALY_DIGEST_LAST_WEEK = "ANOMALY_DIGEST_LAST_WEEK";

const DAY = 86_400_000;

/** The windows each check compares, in days back from now. */
export const CLAIM_RECENT_DAYS = 30;
export const CLAIM_BASELINE_DAYS = 90;
export const REPLY_RECENT_DAYS = 14;
export const REPLY_BASELINE_DAYS = 56;
export const DISCOUNT_RECENT_DAYS = 7;
export const DISCOUNT_BASELINE_DAYS = 90;

/** The furthest back any check reads. */
export const windowStart = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY);

/* ── Warranty claims rising on one model ─────────────────────────────── */

export const CLAIM_MIN_RECENT = 3;
export const CLAIM_FACTOR = 2;

export type ClaimSpike = { model: string; recent: number; usual: number };

/**
 * Models with at least 3 claims in the last 30 days AND at least twice their
 * usual 30 days (the 90 days before, divided by three).
 *
 * Counts, not rates: a model that is selling fast will have more claims for an
 * honest reason, and the email says so.
 */
export function claimSpikes(claims: readonly { model: string; claimedAt: Date }[], now: Date): ClaimSpike[] {
  const recentFrom = now.getTime() - CLAIM_RECENT_DAYS * DAY;
  const baselineFrom = recentFrom - CLAIM_BASELINE_DAYS * DAY;
  const byModel = new Map<string, { label: string; recent: number; baseline: number }>();
  for (const claim of claims) {
    const at = claim.claimedAt.getTime();
    const label = claim.model.trim();
    if (!label || at < baselineFrom || at > now.getTime()) continue;
    const key = label.toLowerCase();
    const row = byModel.get(key) ?? { label, recent: 0, baseline: 0 };
    if (at >= recentFrom) row.recent += 1;
    else row.baseline += 1;
    byModel.set(key, row);
  }
  return [...byModel.values()]
    .map((row) => ({ model: row.label, recent: row.recent, usual: row.baseline / (CLAIM_BASELINE_DAYS / CLAIM_RECENT_DAYS) }))
    .filter((row) => row.recent >= CLAIM_MIN_RECENT && row.recent >= CLAIM_FACTOR * row.usual)
    .sort((a, b) => b.recent - a.recent || a.model.localeCompare(b.model));
}

/* ── One person's first replies getting slower ───────────────────────── */

export const REPLY_MIN_RECENT = 5;
export const REPLY_MIN_BASELINE = 10;
export const REPLY_FACTOR = 2;
export const REPLY_MIN_SLIP_MINUTES = 30;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export type ReplySlip = { person: string; recentMinutes: number; usualMinutes: number; tickets: number };

/**
 * People whose median time to a first reply over the last 14 days is at least
 * double their OWN median for the 8 weeks before, and at least 30 minutes
 * slower. Compared with themselves, never with a colleague: a part-timer is not
 * "slow" for being part-time. The median, so one ticket left over a weekend
 * cannot flag anybody.
 */
export function replySlips(
  tickets: readonly { personId: string; createdAt: Date; firstResponseAt: Date }[],
  names: ReadonlyMap<string, string>,
  now: Date,
): ReplySlip[] {
  const recentFrom = now.getTime() - REPLY_RECENT_DAYS * DAY;
  const baselineFrom = recentFrom - REPLY_BASELINE_DAYS * DAY;
  const byPerson = new Map<string, { recent: number[]; baseline: number[] }>();
  for (const ticket of tickets) {
    const opened = ticket.createdAt.getTime();
    const minutes = (ticket.firstResponseAt.getTime() - opened) / 60_000;
    if (opened < baselineFrom || opened > now.getTime() || !(minutes >= 0)) continue;
    const row = byPerson.get(ticket.personId) ?? { recent: [], baseline: [] };
    (opened >= recentFrom ? row.recent : row.baseline).push(minutes);
    byPerson.set(ticket.personId, row);
  }
  const slips: ReplySlip[] = [];
  for (const [personId, row] of byPerson) {
    if (row.recent.length < REPLY_MIN_RECENT || row.baseline.length < REPLY_MIN_BASELINE) continue;
    const recentMinutes = median(row.recent);
    const usualMinutes = median(row.baseline);
    if (recentMinutes < REPLY_FACTOR * usualMinutes || recentMinutes - usualMinutes < REPLY_MIN_SLIP_MINUTES) continue;
    slips.push({ person: names.get(personId)?.trim() || "A team member", recentMinutes, usualMinutes, tickets: row.recent.length });
  }
  return slips.sort((a, b) => b.recentMinutes / Math.max(b.usualMinutes, 1) - a.recentMinutes / Math.max(a.usualMinutes, 1));
}

/* ── Discounts well above what this workspace usually gives ──────────── */

export const DISCOUNT_MIN_HISTORY = 20;
export const DISCOUNT_MIN_PCT = 5;
export const DISCOUNT_MARGIN_PCT = 2;
export const DISCOUNT_MAX_LISTED = 10;

export type QuoteLine = { qty: number; unitPriceCents: number; discountPct: number; kind: string };

/**
 * The discount on a quote as one percentage of its list value. A trade-in is
 * not a sale line and a zero-price line has nothing to discount, so neither
 * counts. Null when the quote has no priced line.
 */
export function quoteDiscountPct(lines: readonly QuoteLine[]): number | null {
  let list = 0;
  let given = 0;
  for (const line of lines) {
    if (line.kind === "trade_in") continue;
    const value = line.qty * line.unitPriceCents;
    if (!(value > 0)) continue;
    list += value;
    given += value * (Math.min(100, Math.max(0, line.discountPct)) / 100);
  }
  return list > 0 ? (given / list) * 100 : null;
}

/** The value below which `fraction` of the numbers fall (nearest rank). */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

export type DiscountQuote = { id: string; number: number; by: string | null; createdAt: Date; pct: number };
export type UnusualDiscounts = { usualTopPct: number; quotes: DiscountQuote[] };

/**
 * Quotes sent in the last 7 days whose discount is at least 5% AND more than 2
 * points above the level 95% of the previous 90 days' quotes stayed under.
 * Needs 20 earlier quotes to know what "usual" is; a new workspace hears nothing.
 */
export function unusualDiscounts(quotes: readonly DiscountQuote[], now: Date): UnusualDiscounts | null {
  const recentFrom = now.getTime() - DISCOUNT_RECENT_DAYS * DAY;
  const baselineFrom = recentFrom - DISCOUNT_BASELINE_DAYS * DAY;
  const history = quotes.filter((q) => q.createdAt.getTime() >= baselineFrom && q.createdAt.getTime() < recentFrom).map((q) => q.pct);
  if (history.length < DISCOUNT_MIN_HISTORY) return null;
  const usualTopPct = percentile(history, 0.95);
  const bar = Math.max(DISCOUNT_MIN_PCT, usualTopPct + DISCOUNT_MARGIN_PCT);
  const unusual = quotes
    .filter((q) => q.createdAt.getTime() >= recentFrom && q.createdAt.getTime() <= now.getTime() && q.pct >= bar)
    .sort((a, b) => b.pct - a.pct || b.number - a.number);
  return unusual.length ? { usualTopPct, quotes: unusual } : null;
}

/* ── The email ───────────────────────────────────────────────────────── */

const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")}%`;

/** Minutes as a person would say them: "45 min", "3 h 20 min", "2 days". */
export function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  if (whole < 48 * 60) {
    const hours = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.round(whole / 1440)} days`;
}

/** A name on one line: no line breaks or control characters from a record's own text. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);

export type AnomalyFindings = { claims: ClaimSpike[]; replies: ReplySlip[]; discounts: UnusualDiscounts | null };

export const findingCount = (found: AnomalyFindings): number => found.claims.length + found.replies.length + (found.discounts?.quotes.length ?? 0);

/** The email — or nothing to send in a week where nothing stood out. */
export function anomalyDigestEmail(input: { brand: string; origin: string } & AnomalyFindings): { subject: string; text: string } | null {
  const total = findingCount(input);
  if (total === 0) return null;
  const lines: string[] = ["Things that moved this week that are worth a look. Each line shows the recent figure beside the usual one.", ""];

  if (input.claims.length) {
    lines.push("WARRANTY CLAIMS RISING");
    for (const spike of input.claims) {
      lines.push(`  - ${oneLine(spike.model)}: ${spike.recent} claims in the last ${CLAIM_RECENT_DAYS} days (usually ${spike.usual === 0 ? "none" : `about ${count(Math.round(spike.usual * 10) / 10)}`}).`);
    }
    lines.push("  These are counts, not rates — a model that is selling faster will have more claims.", `  ${input.origin}/warranty`, "");
  }

  if (input.replies.length) {
    lines.push("FIRST REPLIES GETTING SLOWER");
    for (const slip of input.replies) {
      lines.push(`  - ${oneLine(slip.person)}: typically ${duration(slip.recentMinutes)} to a first reply over the last ${REPLY_RECENT_DAYS} days (usually ${duration(slip.usualMinutes)}), across ${slip.tickets} tickets.`);
    }
    lines.push("  Each person is compared with their own earlier weeks. Leave or a heavier load would show up here too.", `  ${input.origin}/cases`, "");
  }

  if (input.discounts) {
    lines.push("DISCOUNTS ABOVE THE USUAL");
    const listed = input.discounts.quotes.slice(0, DISCOUNT_MAX_LISTED);
    for (const quote of listed) {
      lines.push(`  - Q-${quote.number}: ${pct(quote.pct)} off${quote.by ? ` · ${oneLine(quote.by)}` : ""}`, `    ${input.origin}/quotes/${quote.id}`);
    }
    const more = input.discounts.quotes.length - listed.length;
    if (more > 0) lines.push(`  …and ${more} more.`);
    lines.push(`  95% of quotes in the ${DISCOUNT_BASELINE_DAYS} days before stayed at or under ${pct(input.discounts.usualTopPct)}.`, "");
  }

  lines.push("Nothing here is a verdict — it is what changed, for you to look into. Switch this weekly email off in Settings → Automatic jobs & messages.");
  return { subject: `${input.brand}: ${total} thing${total === 1 ? "" : "s"} out of the ordinary this week`, text: lines.join("\n") };
}
