import { addWorkingDays } from "./todayAction";
import { johannesburgDateKey } from "./activityDay";

/**
 * Finance through an outside finance house (Sean, 2026-11-16) — the PURE half. No database: the deal page, the
 * actions, the Attention Centre and the delivery guard all read these rules, and the tests drive them directly.
 */

export const FINANCE_STATUSES = [
  { value: "docs_outstanding", label: "Customer documents outstanding" },
  { value: "submitted", label: "Submitted — waiting for the finance house" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
  { value: "paid_out", label: "Paid out" },
  { value: "withdrawn", label: "Withdrawn — not financing" },
] as const;

export type FinanceStatus = (typeof FINANCE_STATUSES)[number]["value"];

export const isFinanceStatus = (value: unknown): value is FinanceStatus => FINANCE_STATUSES.some((s) => s.value === value);

export const financeStatusLabel = (status: string): string => FINANCE_STATUSES.find((s) => s.value === status)?.label ?? status;

/** Short, for a pill or a fact. */
export const financeStatusShort = (status: string): string =>
  ({ docs_outstanding: "Docs outstanding", submitted: "Submitted", approved: "Approved", declined: "Declined", paid_out: "Paid out", withdrawn: "Withdrawn" })[status] ?? status;

export const financeTone = (status: string): "success" | "warning" | "danger" | "info" | "neutral" =>
  status === "approved" || status === "paid_out" ? "success" : status === "declined" ? "danger" : status === "withdrawn" ? "neutral" : status === "submitted" ? "info" : "warning";

/**
 * A finance deal can be delivered once the finance house has approved it (or paid). Declined or still waiting: no.
 * Withdrawn means the customer is no longer financing — the deal goes ahead on its own terms.
 */
export function financeBlocksDelivery(status: string | null | undefined): boolean {
  return status === "docs_outstanding" || status === "submitted" || status === "declined";
}

export function deliveryRefusal(financeHouse: string, status: string): string {
  return status === "declined"
    ? `${financeHouse} declined the finance. Delivery can be booked once it's approved — or mark the finance withdrawn if the customer is paying another way.`
    : `Finance with ${financeHouse} isn't approved yet (${financeStatusShort(status).toLowerCase()}). Delivery can be booked once it is.`;
}

/**
 * THE CHASER. A status that is waiting on somebody else goes stale after this many working days (Mon–Fri) unmoved:
 * the customer's documents, or the finance house's answer.
 * ponytail: weekends skipped, public holidays not; read publicHolidays.ts if a holiday week chases a day early.
 */
export const FINANCE_CHASE_WORKING_DAYS = 3;

export type FinanceChase = { detail: string; actionLabel: string; since: Date };

/** What to chase on this finance deal now, or null. Read by the Attention Centre (attention/signals.ts). */
export function financeChase(input: { status: string; statusAt: Date; financeHouse: string; reference: string | null }, now: Date): FinanceChase | null {
  if (input.status !== "docs_outstanding" && input.status !== "submitted") return null;
  const due = addWorkingDays(input.statusAt, FINANCE_CHASE_WORKING_DAYS);
  if (johannesburgDateKey(now) < due) return null;
  const days = workingDaysBetween(input.statusAt, now);
  const ref = input.reference ? ` (${input.reference})` : "";
  return input.status === "submitted"
    ? { detail: `Finance with ${input.financeHouse}${ref} submitted ${days} working days ago — no answer recorded`, actionLabel: "Chase the finance house", since: input.statusAt }
    : { detail: `Customer's finance documents outstanding for ${days} working days (${input.financeHouse})`, actionLabel: "Chase the customer", since: input.statusAt };
}

/**
 * Which financed deal an email from the finance house is about — or null when it can't be told. Its application
 * reference first (a whole word, any case), else the customer's full name; exactly ONE deal, never a guess between two.
 * `text`: the email's subject and body.
 */
export function matchFinanceEmail<D extends { reference: string | null; customer: string }>(text: string, deals: readonly D[]): D | null {
  const folded = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const has = (needle: string) => {
    const n = needle.toLowerCase().replace(/\s+/g, " ").trim();
    if (n.length < 3) return false;
    // Whole word: "APP-7" is not found in "APP-77" (every occurrence is tried).
    for (let at = folded.indexOf(n); at >= 0; at = folded.indexOf(n, at + 1)) {
      if (!/[a-z0-9]/.test(folded[at - 1] ?? " ") && !/[a-z0-9]/.test(folded[at + n.length] ?? " ")) return true;
    }
    return false;
  };
  const byReference = deals.filter((deal) => deal.reference && has(deal.reference));
  const byName = deals.filter((deal) => deal.customer.trim().includes(" ") && has(deal.customer));
  if (byReference.length > 1) return null;
  if (byReference.length === 1) {
    // A reference that points at one deal while the email names ANOTHER financed customer in full: a forwarded or
    // mistyped reference would file their finance on the wrong person — left in the mailbox instead (review of #1138).
    const [deal] = byReference;
    return byName.some((other) => other.customer.trim().toLowerCase() !== deal.customer.trim().toLowerCase()) ? null : deal;
  }
  return byName.length === 1 ? byName[0] : null;
}

/** Whole working days (Mon–Fri) from `from`'s Johannesburg day to `to`'s. */
export function workingDaysBetween(from: Date, to: Date): number {
  const end = johannesburgDateKey(to);
  let days = 0;
  while (addWorkingDays(from, days + 1) <= end) days += 1;
  return days;
}
