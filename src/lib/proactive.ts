import "server-only";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { sendPushToAll } from "./push";
import { tenantOrigin } from "./tenantOrigin";
import { runInTenantScope } from "./tenantScope";
import { assistantUserFor } from "./assistantUser";
import { sendUpdatesToLinkedPhone } from "./assistantWhatsApp";
import { canAccessContact, canAccessLead } from "./permissions";
import { contactName } from "./format";
import type { CronSliceContext } from "./tenantCron";
import {
  ASSISTANT_PROACTIVE_KEY,
  PROACTIVE_QUESTION,
  PROACTIVE_SOURCE,
  WAITING_AFTER_MS,
  WAITING_LOOKBACK_MS,
  isQuietHour,
  johannesburgDayStart,
  proactiveDeliverAt,
  proactiveOn,
  proactivePersonKey,
  proactivePush,
  proactiveText,
  responsiblePerson,
  type ProactiveEvent,
} from "./proactiveRules";

/*
 * PROACTIVE DAX, part 1 — "can't wait" customer activity (plan: docs/proactive-dax-plan-2026-10-18.md).
 *
 * A customer acts — opens a quote, keeps coming back to it, signs it, writes with no answer, books a service — and
 * the person responsible for them hears about it at once: an AssistantTurn (source "proactive") in their Ask
 * history with the red dot, a phone notification that names nobody, and their linked WhatsApp. It rides the path
 * scheduled briefings and chatbot handoffs already use (handoffNotify.ts), and so inherits it: only a VERIFIED phone,
 * the person's own "updates on WhatsApp" switch, WhatsApp's 24-hour rule with the template standing in, and the
 * half-hourly sweep retrying anything not yet sent.
 *
 * ONLY when the owner has switched it on for the workspace AND the person has switched it on for themselves
 * (both default off), and only about a record that person may open. It never contacts the customer.
 *
 * NEVER TWICE: the alert row is unique per person, kind and record. NEVER AT NIGHT: between 20:00 and 08:00 it is
 * held until 08:00, as is anything past the day's ceiling; the sweep delivers what has come due.
 */

/** Whose and about what: the people who could be responsible, and the record (for the access check). */
export type ProactiveTarget = {
  dealOwnerId?: string | null;
  customerOwnerId?: string | null;
  fallbackId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
};

/** How long the event's own request waits for the alert before carrying on; the rest finishes after the response. */
const NOTIFY_WAIT_MS = 2_500;

/**
 * Tell the person responsible. Never rejects and never holds the customer up: this hangs off a customer's own
 * request (opening a quote, signing, booking), so it gets a short wait and then the platform finishes it.
 */
export async function notifyCustomerActivity(tenantId: string | null | undefined, event: ProactiveEvent, target: ProactiveTarget): Promise<void> {
  if (!tenantId) return;
  const work = runInTenantScope({ tenantId, system: false }, () => raise(tenantId, event, target)).catch((error: unknown) =>
    logError("dax-proactive", `raising a ${event.kind} alert failed`, error instanceof Error ? error.name : "unknown").catch(() => {}),
  );
  await finishAfterResponse(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, NOTIFY_WAIT_MS); })]);
  clearTimeout(timer);
}

/**
 * A customer did something with a QUOTE — opened it, came back to it again, signed it. The quote is read here
 * (workspace-qualified), so each caller passes only its id: the deal's owner first, else the customer's, else
 * whoever made the quote. A quote replaced by a revision or deleted is no longer news.
 */
export async function notifyQuoteActivity(
  tenantId: string | null | undefined,
  quoteId: string | null | undefined,
  kind: "quote_opened" | "quote_revisited" | "quote_signed",
): Promise<void> {
  if (!tenantId || !quoteId) return;
  const quote = await basePrisma.quote
    .findFirst({
      where: { id: quoteId, tenantId, deletedAt: null, supersededAt: null },
      select: {
        id: true, number: true, signedAt: true, leadId: true, contactId: true, createdById: true,
        lead: { select: { name: true, assignedToId: true } },
        contact: { select: { firstName: true, lastName: true, company: true, isCompany: true, ownerId: true } },
      },
    })
    .catch(() => null);
  if (!quote) return;
  // Coming back to a quote already signed is not a moment to call.
  if (kind === "quote_revisited" && quote.signedAt) return;
  await notifyCustomerActivity(
    tenantId,
    {
      kind,
      customer: quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "A customer",
      url: `/quotes/${quote.id}`,
      detail: `Q-${quote.number}`,
      recordKey: quote.id,
    },
    {
      dealOwnerId: quote.lead?.assignedToId,
      customerOwnerId: quote.contact?.ownerId,
      fallbackId: quote.createdById,
      leadId: quote.leadId,
      contactId: quote.leadId ? null : quote.contactId,
    },
  );
}

/** Keep the request alive until `work` settles; outside a request (a script, a test) there is nothing to keep. */
async function finishAfterResponse(work: Promise<unknown>): Promise<void> {
  try {
    const { after } = await import("next/server");
    after(() => work);
  } catch {
    // No request to outlive.
  }
}

async function setting(tenantId: string, key: string): Promise<string | null> {
  const row = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { value: true } });
  return row?.value ?? null;
}

/** Both switches: the owner's for the workspace, then the person's own. */
async function switchedOn(tenantId: string, userId: string): Promise<boolean> {
  if (!proactiveOn(await setting(tenantId, ASSISTANT_PROACTIVE_KEY))) return false;
  return proactiveOn(await setting(tenantId, proactivePersonKey(userId)));
}

/** True when a NEW alert was made (now or held); false when off, not theirs, or already told. */
async function raise(tenantId: string, event: ProactiveEvent, target: ProactiveTarget): Promise<boolean> {
  const userId = responsiblePerson(target);
  if (!userId || !(await switchedOn(tenantId, userId))) return false;
  // Still a member of this workspace, and still allowed to open the record — as themselves, with their own access.
  const user = await assistantUserFor(userId);
  if (!user) return false;
  if (target.leadId ? !(await canAccessLead(user, target.leadId)) : target.contactId ? !(await canAccessContact(user, target.contactId)) : true) return false;

  const now = new Date();
  const today = await basePrisma.assistantProactiveAlert.count({ where: { tenantId, userId, createdAt: { gte: johannesburgDayStart(now) } } });
  const deliverAt = proactiveDeliverAt(now, today);
  const text = proactiveText(event, await tenantOrigin(tenantId).catch(() => ""));
  const alert = await basePrisma.assistantProactiveAlert
    .create({ data: { tenantId, userId, kind: event.kind, recordKey: event.recordKey, text, deliverAt }, select: { id: true } })
    .catch((error: unknown) => {
      // The unique key: this person was already told about this — say nothing again.
      if ((error as { code?: string }).code === "P2002") return null;
      throw error;
    });
  if (!alert) return false;
  if (!deliverAt) await deliver(tenantId, alert.id);
  return true;
}

/**
 * Turn one alert into a message. Claimed first (deliveredAt set only if still empty), so two workers never both
 * send it; the switches are read again, so an alert held overnight respects a switch turned off since.
 */
async function deliver(tenantId: string, alertId: string): Promise<boolean> {
  const alert = await basePrisma.assistantProactiveAlert.findFirst({ where: { id: alertId, tenantId }, select: { userId: true, kind: true, text: true } });
  if (!alert) return false;
  const claimed = await basePrisma.assistantProactiveAlert.updateMany({ where: { id: alertId, tenantId, deliveredAt: null }, data: { deliveredAt: new Date() } });
  if (claimed.count !== 1) return false;
  if (!(await switchedOn(tenantId, alert.userId))) return false;
  const turn = await basePrisma.assistantTurn.create({
    data: { tenantId, userId: alert.userId, question: PROACTIVE_QUESTION, answer: alert.text, source: PROACTIVE_SOURCE },
    select: { id: true },
  });
  await basePrisma.assistantProactiveAlert.updateMany({ where: { id: alertId, tenantId }, data: { turnId: turn.id } });
  await sendPushToAll({ title: "DAX", body: proactivePush(alert.kind as ProactiveEvent["kind"]), url: "/assistant" }, "assistant", { tenantId, userId: alert.userId }).catch(() => {});
  await sendUpdatesToLinkedPhone(tenantId, alert.userId).catch(() => {});
  return true;
}

/**
 * The half-hourly part (the assistant cron): alerts held for the morning that are now due, and customers who wrote
 * and have waited past WAITING_AFTER_MS with no answer from anyone. Stops between alerts when the budget says so.
 */
export async function sweepProactive(tenantId: string, budget: Pick<CronSliceContext, "shouldStop">): Promise<{ delivered: number; raised: number }> {
  const stats = { delivered: 0, raised: 0 };
  if (!proactiveOn(await setting(tenantId, ASSISTANT_PROACTIVE_KEY))) return stats;
  const now = new Date();

  const due = await basePrisma.assistantProactiveAlert.findMany({
    where: { tenantId, deliveredAt: null, deliverAt: { lte: now } },
    orderBy: { deliverAt: "asc" },
    take: 50,
    select: { id: true },
  });
  for (const { id } of due) {
    if (budget.shouldStop(10_000)) return stats;
    if (await deliver(tenantId, id).catch(() => false)) stats.delivered += 1;
  }

  // Waiting customers: only in working hours — at 08:00 the night's messages that are still unanswered come up.
  if (isQuietHour(now)) return stats;
  const waiting = await basePrisma.conversation.findMany({
    where: {
      tenantId,
      status: "open",
      mutedAt: null,
      lastDirection: "inbound",
      lastInboundAt: { lte: new Date(now.getTime() - WAITING_AFTER_MS), gte: new Date(now.getTime() - WAITING_LOOKBACK_MS) },
    },
    orderBy: { lastInboundAt: "asc" },
    take: 30,
    select: {
      id: true,
      channel: true,
      lastInboundAt: true,
      assignedToId: true,
      contact: { select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, ownerId: true } },
      lead: { select: { id: true, name: true, assignedToId: true } },
      messages: { where: { direction: "inbound" }, orderBy: { occurredAt: "desc" }, take: 1, select: { body: true } },
    },
  });
  for (const c of waiting) {
    if (budget.shouldStop(10_000)) break;
    const customer = c.contact ? contactName(c.contact) : c.lead?.name ?? "A customer";
    const event: ProactiveEvent = {
      kind: "customer_waiting",
      customer,
      url: c.contact ? `/contacts/${c.contact.id}` : c.lead ? `/leads/${c.lead.id}` : "/inbox",
      detail: c.channel === "whatsapp" ? "WhatsApp" : c.channel === "email" ? "email" : c.channel,
      snippet: c.messages[0]?.body ?? undefined,
      minutesAgo: c.lastInboundAt ? Math.round((now.getTime() - c.lastInboundAt.getTime()) / 60_000) : undefined,
      // One alert per message burst: a new message after an answer is a new wait.
      recordKey: `${c.id}:${c.lastInboundAt?.toISOString() ?? ""}`,
    };
    const raised = await raise(tenantId, event, {
      dealOwnerId: c.assignedToId ?? c.lead?.assignedToId,
      customerOwnerId: c.contact?.ownerId,
      leadId: c.contact ? null : c.lead?.id,
      contactId: c.contact?.id,
    }).catch(async (error: unknown) => {
      await logError("dax-proactive", "a waiting-customer alert failed", error instanceof Error ? error.name : "unknown").catch(() => {});
      return false;
    });
    if (raised) stats.raised += 1;
  }
  return stats;
}
