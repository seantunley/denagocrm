/** The Deals Centre's views and totals (brief §3). Pure — dealsCentre.ts loads, this decides. */

export const DEALS_VIEWS = [
  { key: "active", label: "Active", hint: "Quotes out with the customer and accepted deals not delivered yet." },
  { key: "blocked", label: "Blocked", hint: "Accepted deals that cannot be handed over yet, with what is in the way." },
  { key: "accepted", label: "Accepted", hint: "Accepted quotes not delivered yet." },
  { key: "deposit", label: "Deposit outstanding", hint: "Accepted deals that ask for a deposit that has not come in." },
  { key: "finance", label: "Finance pending", hint: "Deals financed through an outside finance house that has not paid out yet." },
  { key: "ready", label: "Ready for delivery", hint: "Accepted, deposit in (or none asked), unit allocated and through PDI, finance not holding it." },
  { key: "completed", label: "Completed", hint: "Delivered deals." },
  { key: "all", label: "All", hint: "Every current quote you can see, drafts included." },
] as const;
export type DealsView = (typeof DEALS_VIEWS)[number]["key"];

export function dealsView(show: string | undefined, financeOn: boolean): DealsView {
  const found = DEALS_VIEWS.find((view) => view.key === show && (view.key !== "finance" || financeOn));
  return found?.key ?? "active";
}

export type DealRow = {
  id: string;
  number: number;
  status: string;
  currency: string | null;
  customer: { firstName: string; lastName: string | null; company: string | null; isCompany: boolean } | null;
  owner: string | null;
  totalCents: number;
  receivedCents: number;
  /** What is still owed. Only an accepted quote is an invoice, so only it owes anything. */
  balanceCents: number;
  financeStatus: string | null;
  deliveryScheduledFor: Date | null;
  deliveredAt: Date | null;
  blockers: string[];
  ready: boolean;
};

export type DealTotals = { currency: string | null; count: number; proposed: number; committed: number; received: number; owed: number };

/**
 * Per currency, never added across (multicurrency module):
 *  - proposed: sent, not accepted yet — what is on the table;
 *  - committed: accepted — what has been sold;
 *  - received / owed: money in against accepted deals, and what is still due.
 * Drafts, declined and cancelled quotes are counted in neither money line.
 */
export function dealTotals(rows: Pick<DealRow, "currency" | "status" | "totalCents" | "receivedCents" | "balanceCents">[]): DealTotals[] {
  const out = new Map<string, DealTotals>();
  for (const row of rows) {
    const key = row.currency ?? "";
    const t = out.get(key) ?? { currency: row.currency, count: 0, proposed: 0, committed: 0, received: 0, owed: 0 };
    t.count += 1;
    if (row.status === "sent") t.proposed += row.totalCents;
    if (row.status === "accepted") {
      t.committed += row.totalCents;
      t.received += row.receivedCents;
      t.owed += Math.max(0, row.balanceCents);
    }
    out.set(key, t);
  }
  return [...out.values()];
}
