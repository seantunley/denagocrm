/** The Deals Centre's views and totals (brief §3). Pure — dealsCentre.ts loads, this decides. */
import { AUTOMOTIVE_LIFECYCLE, type Blocker, type BlockerKey, type Lifecycle } from "./dealMilestones";

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

/** The blockers panel: each kind, in the workspace's own words, what it means, and where it is fixed. */
export function blockerInfo(lifecycle: Lifecycle = AUTOMOTIVE_LIFECYCLE): Record<BlockerKey, { title: string; detail: string; action?: { label: string; href: string } }> {
  const l = lifecycle.labels;
  const lower = (s: string) => s.toLowerCase();
  return {
    accept: { title: `Not ${lower(l.accepted)} yet`, detail: `${l.quote}s with the customer, waiting for a signature.` },
    deposit: { title: `${l.deposit} not received`, detail: `The ${lower(l.deposit)} the ${lower(l.quote)} asks for has not come in.`, action: { label: "Delivery board", href: "/deliveries" } },
    finance: { title: "Finance approval pending", detail: `The finance house has not approved — ${lower(l.delivery)} is held.`, action: { label: "Finance", href: "/finance" } },
    stock: { title: `${l.stock} not allocated`, detail: "No unit sold or reserved against the deal.", action: { label: "Stock", href: "/stock" } },
    pdi: { title: `${l.pdi} incomplete`, detail: "An allocated unit has not passed pre-delivery inspection.", action: { label: "Stock", href: "/stock" } },
    delivery: { title: `${l.delivery} not booked`, detail: `No ${lower(l.delivery)} date set with the customer.`, action: { label: "Delivery board", href: "/deliveries" } },
  };
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
  financePending: boolean;
  depositOutstanding: boolean;
  deliveryScheduledFor: Date | null;
  deliveredAt: Date | null;
  blockers: Blocker[];
  ready: boolean;
  /** The step the deal is on, and steps done out of the ones that apply. */
  milestone: string;
  progress: { done: number; of: number };
};

/** Which in-play rows a view shows. Completed and All are read from the database separately. */
export function inView(row: DealRow, view: DealsView): boolean {
  switch (view) {
    case "active":
      return true;
    case "accepted":
      return row.status === "accepted";
    case "blocked":
      return row.status === "accepted" && !row.ready;
    case "deposit":
      return row.depositOutstanding;
    case "finance":
      return row.financePending;
    case "ready":
      return row.ready;
    default:
      return false;
  }
}

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

/** How many in-play deals each blocker holds up. */
export function blockerCounts(rows: Pick<DealRow, "blockers">[]): Record<BlockerKey, number> {
  const out = { accept: 0, deposit: 0, finance: 0, stock: 0, pdi: 0, delivery: 0 } as Record<BlockerKey, number>;
  for (const row of rows) for (const blocker of row.blockers) out[blocker.key] += 1;
  return out;
}
