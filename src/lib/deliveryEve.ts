import "server-only";
import { prisma } from "./db";
import { contactName } from "./format";
import { isModuleEnabled } from "./modules/enabled";
import { currentTenantScope } from "./tenantScope";
import { tenantOrigin } from "./tenantOrigin";
import { loadFacts } from "./assistantGoals";
import { notifyCustomerActivity, setting } from "./proactive";
import { ASSISTANT_PROACTIVE_KEY, isQuietHour, proactiveOn } from "./proactiveRules";
import { deliveryEveKey, deliveryEveText, tomorrowWindow } from "./deliveryEveRules";
import type { CronSliceContext } from "./tenantCron";

/**
 * The day before a delivery (deliveryEveRules has the words). The assistant cron, in the workspace's own scope:
 * signed deals booked for tomorrow, each checked once — deposit, invoice, cart and PDI — and the deal's salesperson
 * (else the customer's owner, else whoever made the quote) told through proactive DAX: both its switches (the
 * owner's and the person's own, off until switched on), their access to the deal, quiet hours, the daily ceiling,
 * and never twice for the same booked day. A delivery rebooked to another day is checked again for that day.
 * Never contacts the customer.
 */
export async function runDeliveryEve(tenantId: string, budget: Pick<CronSliceContext, "shouldStop">, now = new Date()): Promise<number> {
  const scope = currentTenantScope();
  if (!scope || scope.system || scope.tenantId !== tenantId) return 0;
  if (!proactiveOn(await setting(tenantId, ASSISTANT_PROACTIVE_KEY)) || isQuietHour(now)) return 0;
  if (!(await isModuleEnabled("automotive"))) return 0;

  const tomorrow = tomorrowWindow(now);
  const quotes = await prisma.quote.findMany({
    where: { tenantId, status: "accepted", deletedAt: null, supersededAt: null, deliveredAt: null, deliveryScheduledFor: tomorrow },
    orderBy: { deliveryScheduledFor: "asc" },
    take: 50,
    select: {
      id: true, leadId: true, contactId: true, createdById: true,
      lead: { select: { name: true, assignedToId: true } },
      contact: { select: { firstName: true, lastName: true, company: true, isCompany: true, ownerId: true } },
    },
  });
  const origin = quotes.length ? await tenantOrigin(tenantId).catch(() => "") : "";
  let raised = 0;
  for (const q of quotes) {
    if (budget.shouldStop(10_000)) break;
    const loaded = await loadFacts(tenantId, q.id);
    if (!loaded || loaded.facts.lost || !loaded.facts.deliveryScheduledFor) continue;
    const customer = (q.contact ? contactName(q.contact) : q.lead?.name) || "a customer";
    await notifyCustomerActivity(
      tenantId,
      {
        kind: "delivery_eve",
        customer,
        url: `/deals/${q.id}`,
        detail: deliveryEveText(loaded.facts, customer, origin),
        // Once per booked day (not time): rebooked to another day, it is a new check.
        recordKey: deliveryEveKey(q.id, loaded.facts.deliveryScheduledFor),
      },
      { dealOwnerId: q.lead?.assignedToId, customerOwnerId: q.contact?.ownerId, fallbackId: q.createdById, leadId: q.leadId, contactId: q.leadId ? null : q.contactId },
    );
    raised += 1;
  }
  return raised;
}
