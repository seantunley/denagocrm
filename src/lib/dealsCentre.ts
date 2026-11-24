import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { receivedCents } from "@/lib/accountStatement";
import { financeBlocksDelivery, financeIsClosed } from "@/lib/dealFinanceRules";
import { dealBlockers, readyForDelivery, type DealFacts } from "@/lib/dealMilestones";
import { isModuleEnabled } from "@/lib/modules/enabled";
import type { PermissionUser } from "@/lib/permissions";
import { payableTotalCents } from "@/lib/pricing";
import { quoteListFilter } from "@/lib/quoteListQuery";
import { dealTotals, type DealRow, type DealsView } from "./dealsCentreRules";

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

/** Where the view lives in the database; "ready" and "blocked" are worked out from the facts after. */
function viewWhere(view: DealsView, financeQuoteIds: string[]): Prisma.QuoteWhereInput {
  switch (view) {
    case "active":
      return { status: { in: ["sent", "accepted"] }, deliveredAt: null };
    case "accepted":
    case "ready":
    case "blocked":
      return { status: "accepted", deliveredAt: null };
    case "deposit":
      return { status: "accepted", deliveredAt: null, depositPaidAt: null, depositType: { not: null }, depositValue: { gt: 0 } };
    case "finance":
      return { status: { in: ["sent", "accepted"] }, deliveredAt: null, id: { in: financeQuoteIds } };
    case "completed":
      return { deliveredAt: { not: null } };
    case "all":
      return {};
  }
}

export async function loadDealsCentre(user: PermissionUser, view: DealsView, { q }: { q?: string }) {
  const financeOn = await isModuleEnabled("finance");
  // Live finance by quote (Finance module): what holds delivery, and the "Finance pending" view.
  const finances = financeOn
    ? await prisma.dealFinance.findMany({ where: { quoteId: { not: null } }, select: { quoteId: true, status: true }, orderBy: { statusAt: "desc" } })
    : [];
  const financeByQuote = new Map<string, string>();
  for (const row of finances) if (row.quoteId && !financeByQuote.has(row.quoteId)) financeByQuote.set(row.quoteId, row.status);
  const pendingFinance = [...financeByQuote].filter(([, status]) => !financeIsClosed(status)).map(([id]) => id);

  const { where: scope } = await quoteListFilter(user, { q });
  const where: Prisma.QuoteWhereInput = { AND: [scope, viewWhere(view, pendingFinance)] };

  // ponytail: totals are summed over every quote in the view (items loaded to price them) — fine for the hundreds a
  // workspace has in play; for "All"/"Completed" on a very large workspace, store a priced total on the quote instead.
  const all = await prisma.quote.findMany({ where, select: SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const payments = all.length
    ? await prisma.quotePayment.findMany({ where: { quoteId: { in: all.map((quote) => quote.id) } }, select: { quoteId: true, amountCents: true, voidedAt: true } })
    : [];
  const paymentsOf = new Map<string, { amountCents: number; voidedAt: Date | null }[]>();
  for (const payment of payments) paymentsOf.set(payment.quoteId, [...(paymentsOf.get(payment.quoteId) ?? []), payment]);

  let rows = all.map((quote) => toRow(quote, paymentsOf.get(quote.id) ?? [], financeByQuote.get(quote.id) ?? null));
  if (view === "ready") rows = rows.filter((row) => row.ready);
  if (view === "blocked") rows = rows.filter((row) => !row.ready);

  // The page pages these (listPaging), so the totals above it always cover the whole view.
  return { rows, totals: dealTotals(rows), financeOn };
}

function toRow(quote: Row, payments: { amountCents: number; voidedAt: Date | null }[], financeStatus: string | null): DealRow {
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
    deliveryScheduledFor: quote.deliveryScheduledFor,
    deliveredAt: quote.deliveredAt,
    blockers: dealBlockers(facts),
    ready: readyForDelivery(facts),
  };
}
