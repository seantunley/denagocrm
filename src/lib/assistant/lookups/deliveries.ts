import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { formatZAR } from "../../format";
import { withCurrency } from "../../currencyRules";
import { payableTotalCents } from "../../pricing";
import { johannesburgDateKey } from "../../activityDay";
import { getRegionalSettings } from "../../settings";
import { isModuleEnabled } from "../../modules/enabled";
import { getAccessibleQuoteIds, hasAnyPermission } from "../../permissions";
import { deliveryArgs } from "../../crmAssistantPlan";
import { DAY, CANDIDATES, ToolOutput, User, dateKey, refused } from "../lookupKit";
import { nameOfContact } from "./schedule";

/**
 * Signed deals on their way to the customer, in the deliveries board's own
 * stages (invoice → deposit → schedule → deliver), so DAX and the board agree.
 */
export async function deliveries(user: User, raw: z.infer<typeof deliveryArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return refused("deliveries");
  // /deliveries is part of the automotive module; off → the board isn't there.
  if (!(await isModuleEnabled("automotive"))) return refused("deliveries (switched off for this workspace)");
  const args = deliveryArgs.parse(raw);
  const ids = await getAccessibleQuoteIds(user);
  const recent = args.stage === "delivered_recently";
  const quotes = await prisma.quote.findMany({
    where: {
      status: "accepted",
      supersededAt: null,
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      deliveredAt: recent ? { gte: new Date(Date.now() - 14 * DAY) } : null,
    },
    orderBy: { updatedAt: "asc" },
    take: CANDIDATES,
    select: {
      id: true, number: true, invoicedAt: true, depositPaidAt: true, depositPaidCents: true, deliveryScheduledFor: true, deliveredAt: true,
      taxInclusive: true, currency: true, depositType: true, depositValue: true, items: true, fees: true,
      contact: { select: { firstName: true, lastName: true } },
      lead: { select: { id: true, name: true } },
    },
  });
  const today = new Date(`${johannesburgDateKey(new Date())}T00:00:00+02:00`);
  // The board's own rule (deliveries/page.tsx colOf).
  const stageOf = (q: (typeof quotes)[number]) =>
    q.deliveredAt ? "delivered"
      : !q.invoicedAt ? "to_invoice"
        : !q.depositPaidAt ? "awaiting_deposit"
          : !q.deliveryScheduledFor ? "to_schedule"
            : q.deliveryScheduledFor < today ? "overdue" : "scheduled";
  const wanted = args.stage && !recent ? args.stage : null;
  const matching = quotes
    .map((q) => ({ q, stage: stageOf(q) }))
    .filter(({ stage }) => !wanted || stage === wanted);
  const take = args.limit ?? 15;
  const page = matching.slice(0, take);
  const customer = (q: (typeof quotes)[number]) => nameOfContact(q.contact) ?? q.lead?.name ?? "no customer";
  const moneyFmt = await getRegionalSettings();
  return {
    truncated: matching.length > take || quotes.length === CANDIDATES,
    data: page.map(({ q, stage }) => ({
      quote: `Q-${q.number}`,
      link: `/quotes/${q.id}`,
      leadId: q.lead?.id ?? null,
      customer: customer(q),
      stage,
      total: formatZAR(payableTotalCents(q), withCurrency(moneyFmt, q.currency)),
      invoiced: q.invoicedAt ? dateKey(q.invoicedAt) : "no",
      deposit: q.depositPaidAt ? `paid ${dateKey(q.depositPaidAt)}${q.depositPaidCents ? ` (${formatZAR(q.depositPaidCents, withCurrency(moneyFmt, q.currency))})` : ""}` : "not paid",
      deliveryDate: q.deliveryScheduledFor ? dateKey(q.deliveryScheduledFor) : null,
      delivered: q.deliveredAt ? dateKey(q.deliveredAt) : null,
    })),
    rows: page.map(({ q, stage }) => ({ label: `Q-${q.number} — ${customer(q)}`, detail: stage.replace(/_/g, " "), href: "/deliveries" })),
  };
}
