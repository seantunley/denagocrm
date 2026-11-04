import "server-only";
import { basePrisma } from "./db";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { tenantOrigin } from "./tenantOrigin";
import { hasAnyPermission } from "./permissions";
import { assistantUserFor } from "./assistantUser";
import { sendUpdatesToLinkedPhone } from "./assistantWhatsApp";
import { HANDOFF_SEND_WAIT_MS } from "./assistantWhatsAppRules";
import { runtimeFlowTenantId } from "./flowScope";
import type { ActionOutcome } from "./flow";

/**
 * TELL SOMEONE (Node-RED's notification nodes; Sean, 2026-11-04): a chatbot step tells ONE chosen staff member
 * "A customer just asked for the price list" while the bot carries on with the customer.
 *
 * It rides on what the handoff to a person already uses (handoffNotify): an AssistantTurn in the person's own Ask
 * history (the red dot), delivered to their linked WhatsApp by sendUpdatesToLinkedPhone — verified link, their
 * "updates on this phone" switch, WhatsApp's 24-hour rule and quiet hours, retried by the half-hourly sweep — plus a
 * push to their own devices. So it is never lost: at night it waits in the CRM and on WhatsApp in the morning.
 *
 * The text can name the customer, so the person must still be in this workspace and allowed to see customer
 * conversations. Logged on the customer's record — the staff member's name only, never the text.
 */
export async function notifyStaffFromFlow(
  channel: string,
  input: { userId: string; text: string },
  customer: { contactId: string | null; leadId: string | null },
): Promise<ActionOutcome> {
  const tenantId = runtimeFlowTenantId();
  const member = await basePrisma.tenantMember.findFirst({ where: { tenantId, userId: input.userId }, select: { userId: true } });
  const user = member ? await assistantUserFor(input.userId) : null;
  if (!user) return { ok: false, reason: "That person is no longer in this workspace" };
  if (!(await hasAnyPermission(user, "inbox.view", "inbox.reply"))) return { ok: false, reason: "That person can't see customer conversations" };

  const text = input.text.trim().slice(0, 1000) || "The chatbot has something for you.";
  const path = customer.contactId ? `/contacts/${customer.contactId}` : customer.leadId ? `/leads/${customer.leadId}` : "/inbox";
  const origin = await tenantOrigin(tenantId).catch(() => "");
  await basePrisma.assistantTurn.create({
    data: { tenantId, userId: user.id, question: `From the chatbot (${channel})`, answer: `${text}\n\n${origin}${path}`, source: "flow_notify" },
  });
  await sendPushToAll({ title: `Chatbot (${channel})`, body: text, url: path }, "bot_notify", { tenantId, userId: user.id }).catch(() => 0);
  await logAudit({
    action: "chatbot.notify",
    summary: `Chatbot told ${user.name} about this ${channel} conversation`,
    contactId: customer.contactId ?? undefined,
    leadId: customer.leadId ?? undefined,
    userName: "Chatbot",
    actorType: "system",
    source: "chatbot",
  }).catch(() => {});

  // Sent now if it can be within the same short wait the handoff allows; otherwise the sweep sends it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    sendUpdatesToLinkedPhone(tenantId, user.id).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(resolve, HANDOFF_SEND_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  return { ok: true };
}
