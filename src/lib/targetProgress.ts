import { prisma } from "./db";
import { baseValueCents } from "./currencyRules";

/** The four monthly goals the Targets page sets. Money is in cents of the base currency. */
export const TARGET_METRICS = [
  { id: "leads", label: "New leads", kind: "count" },
  { id: "sales_value", label: "Sales value", kind: "money" },
  { id: "deliveries", label: "Deliveries", kind: "count" },
  { id: "services", label: "Services completed", kind: "count" },
] as const;
export type TargetMetricId = (typeof TARGET_METRICS)[number]["id"];

/**
 * One month's targets and what was done against them — THE rule, read by the Targets page and by DAX (Sean,
 * 2026-11-14: DAX must know the targets) so the two can never disagree. Counted from `monthStart` (and before
 * `monthEnd`, when given — a past month); the workspace is named in every query.
 *
 * Each by the day the thing HAPPENED, never a later edit: leads CREATED in the month; sales value = deals WON in the
 * month (wonAt, set once — review of #1107: by last update, a deal won on 31 Oct and edited on 2 Nov moved to
 * November; a legacy deal with no wonAt falls back to its last update), base currency only (a target is one number);
 * quotes DELIVERED in the month; service records DATED in the month. Deleted leads and quotes don't count.
 */
export async function targetProgress(tenantId: string, period: string, monthStart: Date, monthEnd?: Date) {
  const within = { gte: monthStart, ...(monthEnd ? { lt: monthEnd } : {}) };
  const [targets, leads, wonLeads, deliveries, services] = await Promise.all([
    prisma.target.findMany({ where: { tenantId, period } }),
    prisma.lead.count({ where: { tenantId, deletedAt: null, createdAt: within } }),
    prisma.lead.findMany({
      where: { tenantId, deletedAt: null, status: "won", OR: [{ wonAt: within }, { wonAt: null, updatedAt: within }] },
      select: { valueCents: true, currency: true },
    }),
    prisma.quote.count({ where: { tenantId, deletedAt: null, deliveredAt: within } }),
    prisma.serviceRecord.count({ where: { tenantId, serviceDate: within } }),
  ]);
  const targetMap = new Map<string, number>(targets.map((target) => [target.metric, target.value]));
  const actuals: Record<TargetMetricId, number> = {
    leads,
    sales_value: wonLeads.reduce((sum, lead) => sum + baseValueCents(lead), 0),
    deliveries,
    services,
  };
  return { targetMap, actuals };
}
