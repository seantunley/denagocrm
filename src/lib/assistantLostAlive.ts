/**
 * "Lost deals that aren't really lost" (round 2, item 4). A deal marked lost in the last LOST_ALIVE_DAYS for a
 * went-quiet or timing reason ("Gone cold", "Stopped responding", "Buying next year") where the CUSTOMER has done
 * something since: messaged, or opened a quote. Each is offered back as a card — park in Nurture, or reopen — and
 * nothing changes without Confirm. Pure rules here; assistantLostAliveLookup.ts reads the records.
 */

export const LOST_ALIVE_DAYS = 90;

/**
 * The lost reason is free text (the Mark lost box), so "soft" is read from its words. Only these count: a deal
 * lost because they bought elsewhere or it was too expensive is not brought back by a message.
 */
const SOFT_REASON = new RegExp(
  [
    "cold", "quiet", "ghost", "unresponsive", "unreachable", "no contact", "lost contact", "can'?t reach", "couldn'?t reach",
    "no (?:response|reply|answer|feedback)", "not (?:responding|replying|answering)", "stopped (?:responding|replying|answering)",
    "didn'?t (?:respond|reply|answer)", "never (?:responded|replied|answered|came back)",
    "timing", "not ready", "later", "next year", "postpone", "on hold",
  ].join("|"),
  "i",
);

export function softLostReason(reason: string | null | undefined): boolean {
  return Boolean(reason && SOFT_REASON.test(reason));
}

/** The first working day of the month in Johannesburg (Mon–Fri, no earlier weekday this month): the monthly list. */
export function firstWorkingDayOfMonth(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", weekday: "short" }).formatToParts(now);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (weekday === "Sat" || weekday === "Sun") return false;
  // Day 1 on a weekday; or a Monday on day 2 or 3 (the 1st fell on the weekend).
  return day === 1 || (weekday === "Mon" && day <= 3);
}

export type AliveSignal = { at: Date; what: string };

export type LostAliveDeal = {
  leadId: string;
  name: string;
  title: string;
  lostAt: Date;
  lostReason: string;
  salesperson: string | null;
  signals: AliveSignal[];
};

/** Deals with at least one signal AFTER they were lost, the most recent sign of life first. */
export function aliveDeals(deals: readonly LostAliveDeal[]): LostAliveDeal[] {
  return deals
    .map((d) => ({ ...d, signals: d.signals.filter((s) => s.at > d.lostAt).sort((a, b) => b.at.getTime() - a.at.getTime()) }))
    .filter((d) => d.signals.length > 0)
    .sort((a, b) => b.signals[0].at.getTime() - a.signals[0].at.getTime());
}

export const LOST_ALIVE_LEGEND =
  "Deals marked lost in the last 90 days for a went-quiet or timing reason, where the customer has since messaged or opened a quote. " +
  "For each, name the deal, when and why it was lost, and what the customer did since (with its date), with its link. " +
  "Offer ONE card each: park it in Nurture (a nurture card — ask why and the review date if they don't say) or reopen it (a reopen card). " +
  "Never both for the same deal, and nothing changes until they press Confirm. Nobody is contacted.";
