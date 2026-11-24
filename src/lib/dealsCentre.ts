import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { receivedCents } from "@/lib/accountStatement";
import { financeBlocksDelivery, financeIsClosed } from "@/lib/dealFinanceRules";
import { currentMilestone, dealBlockers, dealMilestones, dealProgress, readyForDelivery, type BlockerKey, type DealFacts, type Lifecycle } from "@/lib/dealMilestones";
import { getDealLifecycle } from "@/lib/dealLifecycleServer";
import { isModuleEnabled } from "@/lib/modules/enabled";
import type { PermissionUser } from "@/lib/permissions";
import { payableTotalCents } from "@/lib/pricing";
import { quoteListFilter } from "@/lib/quoteListQuery";
import { DEALS_VIEWS, blockerCounts, dealTotals, inView, type DealRow, type DealsView } from "./dealsCentreRules";

/**
 * The Deals Centre (brief §3): the quotes a person may see, as deals — what each
 * is worth, what has come in, what stands in its way. No deal table of its own:
 * every figure is read from the quote, its payments, its stock and its finance.
 *
 * Grain: one row per CURRENT quote (revisions are excluded by quoteListFilter, so
 * a revised quote is never counted twice). Two accepted quotes on one lead are two
 * orders, so two rows. Standalone quotes (no lead) are included.
 */

const SELECT = {
  id: true,
  number: true,
  status: true,
  currency: true,
  taxInclusive: true,
  depositType: true,
  depositValue: true,
  depositPaidAt: true,
  depositPaidCents: true,
  deliveryScheduledFor: true,
  deliveredAt: true,
  signedAt: true,
  validUntil: true,
  createdAt: true,
  leadId: true,
  contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
  createdBy: { select: { name: true } },
  items: { select: { qty: true, unitPriceCents: true, discountPct: true, taxRatePct: true, optional: true, selected: true, kind: true } },
  fees: { select: { amountCents: true, taxRatePct: true } },
  soldStock: { select: { id: true, pdiStatus: true } },
  // Live reservations only — the deal page's rule; a released one allocates nothing.
  stockReservations: { where: { status: "active" }, select: { stockUnit: { select: { id: true, pdiStatus: true } } } },
} satisfies Prisma.QuoteSelect;

type Row = Prisma.QuoteGetPayload<{ select: typeof SELECT }>;

/** Deals in play: sent or accepted, not handed over. Every view but Completed and All is a cut of these. */
const IN_PLAY: Prisma.QuoteWhereInput = { status: { in: ["sent", "accepted"] }, deliveredAt: null };

/**
 * Everything the Deals Centre shows. The deals in play are read ONCE and every
 * in-play view, tab count, headline number, the blockers panel and the cards are
 * cuts of that one set — so they can never disagree with each other.
 */
export async function loadDealsCentre(user: PermissionUser, view: DealsView, { q, blocker }: { q?: string; blocker?: BlockerKey }) {
  const financeOn = await isModuleEnabled("finance");
  // Live finance by quote (Finance module): what holds delivery, and the "Finance pending" view.
  const finances = financeOn
    ? await prisma.dealFinance.findMany({ where: { quoteId: { not: null } }, select: { quoteId: true, status: true }, orderBy: { statusAt: "desc" } })
    : [];
  const financeByQuote = new Map<string, string>();
  for (const row of finances) if (row.quoteId && !financeByQuote.has(row.quoteId)) financeByQuote.set(row.quoteId, row.status);

  const { where: scope } = await quoteListFilter(user, { q });
  // The workspace's lifecycle (brief §5): its step names, and which steps its deals have.
  const ctx: RowContext = { financeByQuote, lifecycle: await getDealLifecycle() };
  const inPlay = await readRows({ AND: [scope, IN_PLAY] }, ctx);
  const [completedCount, allCount] = await Promise.all([
    prisma.quote.count({ where: { AND: [scope, { deliveredAt: { not: null } }] } }),
    prisma.quote.count({ where: scope }),
  ]);

  // ponytail: Completed and All price every quote they hold (items loaded) — fine for a workspace's history in the
  // thousands; past that, store a priced total on the quote instead.
  let rows =
    view === "completed"
      ? await readRows({ AND: [scope, { deliveredAt: { not: null } }] }, ctx)
      : view === "all"
        ? await readRows(scope, ctx)
        : inPlay.filter((row) => inView(row, view));
  if (blocker) rows = rows.filter((row) => row.blockers.some((b) => b.key === blocker));

  const counts = Object.fromEntries(DEALS_VIEWS.map((v) => [v.key, inPlay.filter((row) => inView(row, v.key)).length])) as Record<DealsView, number>;
  counts.completed = completedCount;
  counts.all = allCount;

  // The page pages these (listPaging), so the totals above it always cover the whole view.
  return { rows, inPlay, counts, totals: dealTotals(rows), blockers: blockerCounts(inPlay), financeOn, lifecycle: ctx.lifecycle };
}

type RowContext = { financeByQuote: Map<string, string>; lifecycle: Lifecycle };

async function readRows(where: Prisma.QuoteWhereInput, { financeByQuote, lifecycle }: RowContext): Promise<DealRow[]> {
  const quotes = await prisma.quote.findMany({ where, select: SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const payments = quotes.length
    ? await prisma.quotePayment.findMany({ where: { quoteId: { in: quotes.map((quote) => quote.id) } }, select: { quoteId: true, amountCents: true, voidedAt: true } })
    : [];
  const paymentsOf = new Map<string, { amountCents: number; voidedAt: Date | null }[]>();
  for (const payment of payments) paymentsOf.set(payment.quoteId, [...(paymentsOf.get(payment.quoteId) ?? []), payment]);
  return quotes.map((quote) => toRow(quote, paymentsOf.get(quote.id) ?? [], financeByQuote.get(quote.id) ?? null, lifecycle));
}

function toRow(quote: Row, payments: { amountCents: number; voidedAt: Date | null }[], financeStatus: string | null, lifecycle: Lifecycle): DealRow {
  const total = Math.round(payableTotalCents(quote));
  const accepted = quote.status === "accepted" || Boolean(quote.signedAt);
  const depositCents =
    quote.depositType === "amount"
      ? Math.round((quote.depositValue ?? 0) * 100)
      : quote.depositType === "percent"
        ? Math.round(total * ((quote.depositValue ?? 0) / 100))
        : 0;
  const stock = [
    ...quote.soldStock,
    ...quote.stockReservations.map((r) => r.stockUnit).filter((unit) => !quote.soldStock.some((sold) => sold.id === unit.id)),
  ];
  const facts: DealFacts = {
    accepted,
    depositCents,
    depositPaid: Boolean(quote.depositPaidAt),
    stock,
    deliveryBooked: Boolean(quote.deliveryScheduledFor),
    delivered: Boolean(quote.deliveredAt),
    financeHolds: financeStatus ? financeBlocksDelivery(financeStatus) : false,
  };
  const received = quote.status === "accepted" ? receivedCents(quote, payments) : 0;
  const milestones = dealMilestones(facts, lifecycle);
  return {
    id: quote.id,
    number: quote.number,
    status: quote.status,
    currency: quote.currency,
    customer: quote.contact,
    owner: quote.createdBy?.name ?? null,
    totalCents: total,
    receivedCents: received,
    balanceCents: quote.status === "accepted" ? total - received : 0,
    financeStatus,
    financePending: Boolean(financeStatus) && !financeIsClosed(financeStatus!),
    depositOutstanding: lifecycle.steps.includes("deposit") && accepted && depositCents > 0 && !facts.depositPaid && !facts.delivered,
    deliveryScheduledFor: quote.deliveryScheduledFor,
    deliveredAt: quote.deliveredAt,
    blockers: dealBlockers(facts, lifecycle),
    ready: readyForDelivery(facts, lifecycle),
    milestone: currentMilestone(milestones).label,
    progress: dealProgress(milestones),
  };
}
