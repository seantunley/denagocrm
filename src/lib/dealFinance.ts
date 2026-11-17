import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getAccessibleLeadIds, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { baseValueCents } from "./currencyRules";
import { ATTENTION_CATEGORY, ATTENTION_WEIGHTS, attentionSignalKey, type AttentionSignal } from "./attention/score";
import type { BriefInput } from "./daxBriefRules";
import { deliveryRefusal, financeBlocksDelivery, financeChase, financeIsClosed, financeStatusShort, financeTone, quoteInPlay, type FinanceChase } from "./dealFinanceRules";
import type { KanbanFinance } from "@/components/deals/KanbanFinancePill";

/*
 * FINANCE IS PER QUOTE (Sean, 2026-11-16: "If I am changing the finance status on Q-1045, it's changing the status
 * on Q-1044"). A deal (lead) can carry several quotes — only one is accepted — so each has its own record. Its lead
 * is kept on it: the Attention Centre, the board and the finance house's emails go by the deal.
 */

export type FinanceDeal = {
  id: string;
  leadId: string;
  quoteId: string | null;
  /** Q-number of the quote this finance is for. */
  quoteNumber: number | null;
  name: string;
  /** The lead's own status: open, or won (signed subject to finance). */
  leadStatus: string;
  ownerId: string | null;
  ownerName: string | null;
  valueCents: number;
  currency: string | null;
  financeHouse: string;
  reference: string | null;
  status: string;
  statusAt: Date;
  /** What to chase now, or null. */
  chase: FinanceChase | null;
};

const QUOTE_STATE = { id: true, number: true, status: true, supersededAt: true, deletedAt: true } as const;
type QuoteState = { id: string; number: number; status: string; supersededAt: Date | null; deletedAt: Date | null };

/** The quotes these finance records are for, by id. A record from before finance was per quote has none. */
async function quotesOf(rows: { quoteId: string | null }[]): Promise<Map<string, QuoteState>> {
  const ids = [...new Set(rows.flatMap((row) => (row.quoteId ? [row.quoteId] : [])))];
  if (ids.length === 0) return new Map();
  const quotes = await prisma.quote.findMany({ where: { id: { in: ids } }, select: QUOTE_STATE });
  return new Map(quotes.map((quote) => [quote.id, quote]));
}

/**
 * Whether a record still counts: its quote is in play. One from before finance was per quote whose deal had no quote
 * (review of #1150) has none and counts for nothing — not chased, not on the board, holds no delivery or supplier. It
 * is kept and shown on the lead's Finance tab (loadUnattachedFinances); new finance goes on the deal's quote.
 */
const counts = (row: { quoteId: string | null }, quotes: Map<string, QuoteState>): boolean => {
  const quote = row.quoteId ? quotes.get(row.quoteId) : undefined;
  return Boolean(quote && quoteInPlay(quote));
};

/**
 * Every financed quote this person may open — on an open deal, or a won one not yet delivered on its finance — with
 * what to chase. The Finance page lists them; the morning brief names the ones to chase. A WON deal is here too: a
 * quote signed subject to finance wins its lead (quoteOutcome.ts), and the Attention Centre reads open deals only.
 * `active`: only those still in play (not paid out or withdrawn, not on a lost deal, not on a cancelled quote).
 */
export async function loadFinanceDeals(user: PermissionUser, now: Date, { active }: { active: boolean }): Promise<FinanceDeal[]> {
  const ids = await getAccessibleLeadIds(user);
  if (ids !== null && ids.length === 0) return [];
  const rows = await prisma.dealFinance.findMany({
    where: {
      ...(ids === null ? {} : { leadId: { in: ids } }),
      ...(active ? { status: { notIn: ["paid_out", "withdrawn"] } } : {}),
    },
    select: { id: true, leadId: true, quoteId: true, status: true, statusAt: true, reference: true, vendor: { select: { name: true } } },
    orderBy: { statusAt: "asc" },
    // ponytail: 300 newest-moved per view; paginate if a workspace runs more financed deals than that at once.
    take: 300,
  });
  if (rows.length === 0) return [];
  const [leads, quotes] = await Promise.all([
    prisma.lead.findMany({
      where: { id: { in: rows.map((row) => row.leadId) }, deletedAt: null, ...(active ? { status: { in: ["open", "won"] } } : {}) },
      select: { id: true, name: true, status: true, valueCents: true, currency: true, assignedToId: true, assignedTo: { select: { name: true } } },
    }),
    quotesOf(rows),
  ]);
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  const out: FinanceDeal[] = [];
  for (const row of rows) {
    const lead = byId.get(row.leadId);
    if (!lead || (active && !counts(row, quotes))) continue;
    out.push({
      id: row.id, leadId: row.leadId, quoteId: row.quoteId, quoteNumber: row.quoteId ? quotes.get(row.quoteId)?.number ?? null : null,
      name: lead.name, leadStatus: lead.status, ownerId: lead.assignedToId, ownerName: lead.assignedTo?.name ?? null,
      valueCents: lead.valueCents, currency: lead.currency, financeHouse: row.vendor.name, reference: row.reference, status: row.status, statusAt: row.statusAt,
      chase: financeChase({ status: row.status, statusAt: row.statusAt, financeHouse: row.vendor.name, reference: row.reference }, now),
    });
  }
  return out;
}

/**
 * The Attention Centre's finance warnings for a batch of ALREADY permission-scoped leads (attention/signals.ts): a
 * status that has sat FINANCE_CHASE_WORKING_DAYS waiting on the customer's documents or the finance house's answer —
 * on a quote still in play. Keyed by the record and the status's date, so moving it along ends the warning and a
 * later wait is a new one, not a snoozed one.
 */
export async function financeAttentionSignals(leadIds: string[], now: Date): Promise<{ leadId: string; signal: AttentionSignal }[]> {
  if (!(await isModuleEnabled("finance"))) return [];
  const waiting = await prisma.dealFinance.findMany({
    where: { leadId: { in: leadIds }, status: { in: ["docs_outstanding", "submitted"] } },
    select: { id: true, leadId: true, quoteId: true, status: true, statusAt: true, reference: true, vendor: { select: { name: true } } },
  });
  const quotes = await quotesOf(waiting);
  return waiting.filter((row) => counts(row, quotes)).flatMap((row) => {
    const chase = financeChase({ status: row.status, statusAt: row.statusAt, financeHouse: row.vendor.name, reference: row.reference }, now);
    const number = row.quoteId ? quotes.get(row.quoteId)?.number : undefined;
    return chase
      ? [{
          leadId: row.leadId,
          signal: {
            kind: "finance_waiting" as const,
            key: attentionSignalKey("finance_waiting", `${row.id}:${row.status}:${row.statusAt.getTime()}`),
            category: ATTENTION_CATEGORY.finance_waiting,
            weight: ATTENTION_WEIGHTS.finance_waiting,
            detail: number ? `Q-${number}: ${chase.detail}` : chase.detail,
            since: chase.since.toISOString(),
            context: "Nothing has moved on the finance since then. Chase, then update the status on the deal.",
            actionHref: `/leads/${row.leadId}?tab=finance`,
            actionLabel: chase.actionLabel,
          },
        }]
      : [];
  });
}

/** Financed quotes to chase, for the morning brief (daxBrief.ts) — in the base currency, like every amount it adds. Finance module only. */
export async function financeToChase(user: PermissionUser, now: Date): Promise<NonNullable<BriefInput["finance"]>> {
  if (!(await isModuleEnabled("finance"))) return [];
  const deals = await loadFinanceDeals(user, now, { active: true });
  return deals
    .filter((deal) => deal.chase)
    .map((deal) => ({
      leadId: deal.leadId, name: deal.name, ownerId: deal.ownerId,
      detail: deal.quoteNumber ? `Q-${deal.quoteNumber}: ${deal.chase!.detail}` : deal.chase!.detail,
      since: deal.chase!.since, valueCents: baseValueCents(deal),
    }));
}

/**
 * The finance pill for each financed lead on the board (KanbanFinancePill), keyed by lead. `leadIds`: the board's own,
 * already permission-scoped. Empty with the Finance module off — and for a cash deal, which has no record. A deal with
 * finance on several quotes shows the one that needs it most: a stalled one, else a live one, else the latest moved;
 * a cancelled quote's finance never shows.
 */
export async function financeOnBoard(leadIds: string[], now: Date): Promise<Map<string, KanbanFinance>> {
  if (leadIds.length === 0 || !(await isModuleEnabled("finance"))) return new Map();
  const rows = await prisma.dealFinance.findMany({
    where: { leadId: { in: leadIds } },
    select: { leadId: true, quoteId: true, status: true, statusAt: true, reference: true, vendor: { select: { name: true } } },
    orderBy: { statusAt: "desc" },
  });
  const quotes = await quotesOf(rows);
  const best = new Map<string, { pill: KanbanFinance; rank: number }>();
  for (const row of rows) {
    if (!counts(row, quotes)) continue;
    const chase = financeChase({ status: row.status, statusAt: row.statusAt, financeHouse: row.vendor.name, reference: row.reference }, now)?.detail ?? null;
    const rank = chase ? 2 : financeIsClosed(row.status) ? 0 : 1;
    if ((best.get(row.leadId)?.rank ?? -1) >= rank) continue; // newest first, so a tie keeps the latest moved
    const number = row.quoteId ? quotes.get(row.quoteId)?.number : undefined;
    best.set(row.leadId, {
      rank,
      pill: { house: row.vendor.name, quote: number ? `Q-${number}` : null, status: financeStatusShort(row.status), tone: financeTone(row.status), chase },
    });
  }
  return new Map([...best].map(([leadId, { pill }]) => [leadId, pill]));
}

/** A quote's finance as the pages show it: the finance house by name. Null when that quote isn't financed. */
export async function loadDealFinance(tenantId: string, quoteId: string) {
  return prisma.dealFinance.findFirst({
    where: { tenantId, quoteId },
    select: { id: true, status: true, statusAt: true, updatedAt: true, reference: true, note: true, vendorId: true, vendor: { select: { name: true } } },
  });
}

export type LeadQuoteFinance = {
  quote: { id: string; number: number; inPlay: boolean };
  finance: Awaited<ReturnType<typeof loadDealFinance>>;
};

/**
 * Each quote on a deal with its finance, for the lead's Finance tab: every quote still in play, and any other that
 * has finance on file (shown, so nothing recorded disappears). Oldest quote first.
 */
export async function loadLeadFinances(tenantId: string, leadId: string): Promise<LeadQuoteFinance[]> {
  const [quotes, finances] = await Promise.all([
    prisma.quote.findMany({ where: { tenantId, leadId, deletedAt: null }, select: QUOTE_STATE, orderBy: { number: "asc" } }),
    prisma.dealFinance.findMany({
      where: { tenantId, leadId },
      select: { id: true, quoteId: true, status: true, statusAt: true, updatedAt: true, reference: true, note: true, vendorId: true, vendor: { select: { name: true } } },
    }),
  ]);
  const byQuote = new Map(finances.map(({ quoteId, ...finance }) => [quoteId, finance]));
  return quotes
    .map((quote) => ({ quote: { id: quote.id, number: quote.number, inPlay: quoteInPlay(quote) }, finance: byQuote.get(quote.id) ?? null }))
    .filter(({ quote, finance }) => quote.inPlay || finance);
}

/** A deal's finance on no quote — from before finance was per quote, when the deal had none. Kept, read-only. */
export async function loadUnattachedFinances(tenantId: string, leadId: string) {
  return prisma.dealFinance.findMany({
    where: { tenantId, leadId, quoteId: null },
    select: { id: true, status: true, statusAt: true, reference: true, note: true, vendor: { select: { name: true } } },
    orderBy: { statusAt: "desc" },
  });
}

/**
 * The finance houses ON THIS DEAL — added as a supplier of type Finance (Sean, 2026-11-16: "the deal will only deal
 * with finance if I put the finance supplier in the deal"). None = a cash deal: no Finance tab, nothing to withdraw.
 */
export async function dealFinanceHouses(tenantId: string, leadId: string): Promise<{ id: string; name: string }[]> {
  const links = await prisma.dealVendor.findMany({
    where: { tenantId, leadId, vendor: { deletedAt: null, kind: "finance" } },
    select: { vendor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return links.map((link) => link.vendor);
}

/**
 * Why THIS QUOTE's delivery can't be booked yet because of its finance — or null. The one guard every booking path
 * goes through (fulfilment.ts scheduleDelivery, which DAX's delivery card calls too). Another quote's finance on the
 * same deal never holds it. The Finance module switched off holds nothing back.
 */
export async function financeDeliveryRefusal(tenantId: string, quoteId: string): Promise<string | null> {
  if (!(await isModuleEnabled("finance"))) return null;
  const finance = await loadDealFinance(tenantId, quoteId);
  return finance && financeBlocksDelivery(finance.status) ? deliveryRefusal(finance.vendor.name, finance.status) : null;
}

/**
 * The same question inside the handover's own transaction (quoteDelivery.ts, a basePrisma transaction: nothing is
 * scoped for us, so the workspace is named). The finance row is held FOR SHARE: a save changing it waits for the
 * handover to commit, or committed first and is seen here.
 */
export async function financeDeliveryRefusalInTx(tx: Prisma.TransactionClient, tenantId: string, quoteId: string): Promise<string | null> {
  if (!(await isModuleEnabled("finance"))) return null;
  const [row] = await tx.$queryRaw<{ status: string; house: string }[]>(Prisma.sql`
    SELECT f."status", v."name" AS house
    FROM "DealFinance" f JOIN "Vendor" v ON v."id" = f."vendorId" AND v."tenantId" = f."tenantId"
    WHERE f."tenantId" = ${tenantId} AND f."quoteId" = ${quoteId}
    FOR SHARE OF f
  `);
  return row && financeBlocksDelivery(row.status) ? deliveryRefusal(row.house, row.status) : null;
}
