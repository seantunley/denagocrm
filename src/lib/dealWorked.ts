import "server-only";

import { prisma } from "./db";

const latest = (a: Date | null | undefined, b: Date | null | undefined) => (!a ? b ?? null : !b ? a : a > b ? a : b);

/**
 * WHEN SOMEBODY LAST WORKED ON EACH DEAL — the one rule for "is it fair to say nobody has contacted them?" (Sean,
 * 2026-11-16: a pinned note of the WhatsApp chat and a booked call still said "New lead — not contacted yet").
 *
 * Anything put on the deal, or on its customer with no deal: every timeline entry (internal notes included) and every
 * activity added, planned or done. A customer's rows on ANOTHER deal are that deal's. A message the outbox never
 * delivered (queued, retrying, dead, cancelled) is left out — then "not contacted" is the truth.
 *
 * Not contact (customerContact.ts is): only what stops "not contacted" / "never contacted" being said. Read by the
 * lead score (leadScoreLoader.ts) and DAX's quiet-lead watch (assistantWatch.ts), so the two can't disagree.
 * Leads with no work at all are absent from the map.
 */
export async function lastWorkedAt(leads: readonly { id: string; contactId: string | null }[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (leads.length === 0) return out;
  const leadId = { in: leads.map((lead) => lead.id) };
  const customers = [...new Set(leads.map((lead) => lead.contactId).filter((id): id is string => Boolean(id)))];
  const contactId = { in: customers };
  // Only these leads' and customers' outbox rows — never the workspace's whole history.
  const unconfirmed = await prisma.botFlowOutbox.findMany({
    where: { communicationId: { not: null }, status: { not: "sent" }, OR: [{ leadId }, ...(customers.length ? [{ contactId }] : [])] },
    select: { communicationId: true },
  });
  const sentOnly = unconfirmed.length ? { id: { notIn: unconfirmed.map((row) => row.communicationId as string) } } : {};
  const [entries, tasks, customerEntries, customerTasks] = await Promise.all([
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId, ...sentOnly }, _max: { occurredAt: true } }),
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId }, _max: { createdAt: true } }),
    customers.length ? prisma.communication.groupBy({ by: ["contactId"], where: { contactId, leadId: null, ...sentOnly }, _max: { occurredAt: true } }) : [],
    customers.length ? prisma.activity.groupBy({ by: ["contactId"], where: { contactId, leadId: null }, _max: { createdAt: true } }) : [],
  ]);
  const byLead = new Map<string, Date | null>();
  for (const row of entries) if (row.leadId) byLead.set(row.leadId, latest(byLead.get(row.leadId), row._max.occurredAt));
  for (const row of tasks) if (row.leadId) byLead.set(row.leadId, latest(byLead.get(row.leadId), row._max.createdAt));
  const byCustomer = new Map<string, Date | null>();
  for (const row of customerEntries) if (row.contactId) byCustomer.set(row.contactId, latest(byCustomer.get(row.contactId), row._max.occurredAt));
  for (const row of customerTasks) if (row.contactId) byCustomer.set(row.contactId, latest(byCustomer.get(row.contactId), row._max.createdAt));
  for (const lead of leads) {
    const at = latest(byLead.get(lead.id), lead.contactId ? byCustomer.get(lead.contactId) : null);
    if (at) out.set(lead.id, at);
  }
  return out;
}
