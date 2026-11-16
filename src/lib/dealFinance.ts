import "server-only";

import { prisma } from "./db";
import { getAccessibleLeadIds, type PermissionUser } from "./permissions";
import { deliveryRefusal, financeBlocksDelivery, financeChase, type FinanceChase } from "./dealFinanceRules";

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

/** A deal's finance as the pages show it: the finance house by name. Null when the deal isn't financed. */
export async function loadDealFinance(tenantId: string, leadId: string) {
  return prisma.dealFinance.findFirst({
    where: { tenantId, leadId },
    select: { id: true, status: true, statusAt: true, reference: true, note: true, vendorId: true, vendor: { select: { name: true } } },
  });
}

/**
 * Why a delivery can't be booked yet because of finance — or null. The one guard every booking path goes through
 * (fulfilment.ts scheduleDelivery, which DAX's delivery card calls too). A quote on no lead has no finance record.
 */
export async function financeDeliveryRefusal(tenantId: string, leadId: string | null): Promise<string | null> {
  if (!leadId) return null;
  const finance = await loadDealFinance(tenantId, leadId);
  return finance && financeBlocksDelivery(finance.status) ? deliveryRefusal(finance.vendor.name, finance.status) : null;
}
