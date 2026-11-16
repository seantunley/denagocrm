import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getAccessibleLeadIds, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { baseValueCents } from "./currencyRules";
import { ATTENTION_CATEGORY, ATTENTION_WEIGHTS, attentionSignalKey, type AttentionSignal } from "./attention/score";
import type { BriefInput } from "./daxBriefRules";
import { deliveryRefusal, financeBlocksDelivery, financeChase, financeStatusShort, financeTone, type FinanceChase } from "./dealFinanceRules";
import type { KanbanFinance } from "@/components/deals/KanbanFinancePill";

export type FinanceDeal = {
  id: string;
  leadId: string;
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

/**
 * Every financed deal this person may open — open, or won and not yet delivered on its finance — with what to chase.
 * The Finance page lists them; the morning brief names the ones to chase. A WON deal is here too: a quote signed
 * subject to finance wins its lead (quoteOutcome.ts), and the Attention Centre reads open deals only.
 * `active`: only those still in play (not paid out or withdrawn, and not on a lost deal).
 */
export async function loadFinanceDeals(user: PermissionUser, now: Date, { active }: { active: boolean }): Promise<FinanceDeal[]> {
  const ids = await getAccessibleLeadIds(user);
  if (ids !== null && ids.length === 0) return [];
  const rows = await prisma.dealFinance.findMany({
    where: {
      ...(ids === null ? {} : { leadId: { in: ids } }),
      ...(active ? { status: { notIn: ["paid_out", "withdrawn"] } } : {}),
    },
    select: { id: true, leadId: true, status: true, statusAt: true, reference: true, vendor: { select: { name: true } } },
    orderBy: { statusAt: "asc" },
    // ponytail: 300 newest-moved per view; paginate if a workspace runs more financed deals than that at once.
    take: 300,
  });
  if (rows.length === 0) return [];
  const leads = await prisma.lead.findMany({
    where: { id: { in: rows.map((row) => row.leadId) }, deletedAt: null, ...(active ? { status: { in: ["open", "won"] } } : {}) },
    select: { id: true, name: true, status: true, valueCents: true, currency: true, assignedToId: true, assignedTo: { select: { name: true } } },
  });
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  const out: FinanceDeal[] = [];
  for (const row of rows) {
    const lead = byId.get(row.leadId);
    if (!lead) continue;
    out.push({
      id: row.id, leadId: row.leadId, name: lead.name, leadStatus: lead.status, ownerId: lead.assignedToId, ownerName: lead.assignedTo?.name ?? null,
      valueCents: lead.valueCents, currency: lead.currency, financeHouse: row.vendor.name, reference: row.reference, status: row.status, statusAt: row.statusAt,
      chase: financeChase({ status: row.status, statusAt: row.statusAt, financeHouse: row.vendor.name, reference: row.reference }, now),
    });
  }
  return out;
}

/**
 * The Attention Centre's finance warnings for a batch of ALREADY permission-scoped leads (attention/signals.ts): a
 * status that has sat FINANCE_CHASE_WORKING_DAYS waiting on the customer's documents or the finance house's answer.
 * Keyed by the status's date, so moving it along ends the warning and a later wait is a new one, not a snoozed one.
 */
export async function financeAttentionSignals(leadIds: string[], now: Date): Promise<{ leadId: string; signal: AttentionSignal }[]> {
  if (!(await isModuleEnabled("finance"))) return [];
  const waiting = await prisma.dealFinance.findMany({
    where: { leadId: { in: leadIds }, status: { in: ["docs_outstanding", "submitted"] } },
    select: { id: true, leadId: true, status: true, statusAt: true, reference: true, vendor: { select: { name: true } } },
  });
  return waiting.flatMap((row) => {
    const chase = financeChase({ status: row.status, statusAt: row.statusAt, financeHouse: row.vendor.name, reference: row.reference }, now);
    return chase
      ? [{
          leadId: row.leadId,
          signal: {
            kind: "finance_waiting" as const,
            key: attentionSignalKey("finance_waiting", `${row.id}:${row.status}:${row.statusAt.getTime()}`),
            category: ATTENTION_CATEGORY.finance_waiting,
            weight: ATTENTION_WEIGHTS.finance_waiting,
            detail: chase.detail,
            since: chase.since.toISOString(),
            context: "Nothing has moved on the finance since then. Chase, then update the status on the deal.",
            actionHref: `/leads/${row.leadId}?tab=finance`,
            actionLabel: chase.actionLabel,
          },
        }]
      : [];
  });
}

/** Financed deals to chase, for the morning brief (daxBrief.ts) — in the base currency, like every amount it adds. Finance module only. */
export async function financeToChase(user: PermissionUser, now: Date): Promise<NonNullable<BriefInput["finance"]>> {
  if (!(await isModuleEnabled("finance"))) return [];
  const deals = await loadFinanceDeals(user, now, { active: true });
  return deals
    .filter((deal) => deal.chase)
    .map((deal) => ({ leadId: deal.leadId, name: deal.name, ownerId: deal.ownerId, detail: deal.chase!.detail, since: deal.chase!.since, valueCents: baseValueCents(deal) }));
}

/**
 * The finance pill for each financed lead on the board (KanbanFinancePill), keyed by lead. `leadIds`: the board's own,
 * already permission-scoped. Empty with the Finance module off — and for a cash deal, which has no record.
 */
export async function financeOnBoard(leadIds: string[], now: Date): Promise<Map<string, KanbanFinance>> {
  if (leadIds.length === 0 || !(await isModuleEnabled("finance"))) return new Map();
  const rows = await prisma.dealFinance.findMany({
    where: { leadId: { in: leadIds } },
    select: { leadId: true, status: true, statusAt: true, reference: true, vendor: { select: { name: true } } },
  });
  return new Map(rows.map((row) => [row.leadId, {
    house: row.vendor.name,
    status: financeStatusShort(row.status),
    tone: financeTone(row.status),
    chase: financeChase({ status: row.status, statusAt: row.statusAt, financeHouse: row.vendor.name, reference: row.reference }, now)?.detail ?? null,
  }]));
}

/** A deal's finance as the pages show it: the finance house by name. Null when the deal isn't financed. */
export async function loadDealFinance(tenantId: string, leadId: string) {
  return prisma.dealFinance.findFirst({
    where: { tenantId, leadId },
    select: { id: true, status: true, statusAt: true, updatedAt: true, reference: true, note: true, vendorId: true, vendor: { select: { name: true } } },
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
 * Why a delivery can't be booked yet because of finance — or null. The one guard every booking path goes through
 * (fulfilment.ts scheduleDelivery, which DAX's delivery card calls too). A quote on no lead has no finance record.
 * The Finance module switched off holds nothing back.
 */
export async function financeDeliveryRefusal(tenantId: string, leadId: string | null): Promise<string | null> {
  if (!leadId || !(await isModuleEnabled("finance"))) return null;
  const finance = await loadDealFinance(tenantId, leadId);
  return finance && financeBlocksDelivery(finance.status) ? deliveryRefusal(finance.vendor.name, finance.status) : null;
}

/**
 * The same question inside the handover's own transaction (quoteDelivery.ts, a basePrisma transaction: nothing is
 * scoped for us, so the workspace is named). The finance row is held FOR SHARE: a save changing it waits for the
 * handover to commit, or committed first and is seen here.
 */
export async function financeDeliveryRefusalInTx(tx: Prisma.TransactionClient, tenantId: string, leadId: string | null): Promise<string | null> {
  if (!leadId || !(await isModuleEnabled("finance"))) return null;
  const [row] = await tx.$queryRaw<{ status: string; house: string }[]>(Prisma.sql`
    SELECT f."status", v."name" AS house
    FROM "DealFinance" f JOIN "Vendor" v ON v."id" = f."vendorId" AND v."tenantId" = f."tenantId"
    WHERE f."tenantId" = ${tenantId} AND f."leadId" = ${leadId}
    FOR SHARE OF f
  `);
  return row && financeBlocksDelivery(row.status) ? deliveryRefusal(row.house, row.status) : null;
}
