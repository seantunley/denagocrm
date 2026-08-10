"use server";

import { revalidatePath } from "next/cache";
import { canAccessContact, canAccessLead, requirePermission } from "@/lib/permissions";
import { waDigits } from "@/lib/whatsapp";
import { deliveryStateForMessages, enqueueStaffMessage, flushBotOutboxConversation } from "@/lib/botOutbox";
import { sendOutcomeMessage, staffReplyIdempotencyKey } from "@/lib/messageDelivery";

export type WaState = { ok?: string; error?: string };

export async function sendWhatsAppMessage(
  _prev: WaState | undefined,
  formData: FormData
): Promise<WaState> {
  const user = await requirePermission("inbox.reply");
  const phone = String(formData.get("phone") ?? "").trim();
  const text = String(formData.get("text") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  const leadId = String(formData.get("leadId") ?? "").trim() || null;
  if (!phone || !text) return { error: "Message is required." };
  if (contactId && !(await canAccessContact(user, contactId))) return { error: "Customer access denied." };
  if (leadId && !(await canAccessLead(user, leadId))) return { error: "Lead access denied." };

  const digits = waDigits(phone);

  /**
   * Record and queue, then deliver — never the other way round.
   *
   * This used to call the provider first and write the Communication after. A
   * provider success followed by a failed insert left the customer holding a
   * message the CRM had no record of: staff were told it failed, retried, and
   * the customer received it twice.
   *
   * The reply box supplies a composition id, not a finished key. The key is
   * derived from that id AND the message it is sending, so a resubmission of the
   * same text resolves to the row that already exists, while text the person
   * CORRECTED after a failure is a different message and actually sends. A key
   * tied to the box alone would have delivered the typo.
   */
  const compositionId = String(formData.get("compositionId") ?? "").trim();
  if (!compositionId) return { error: "This reply is missing its send key — reload the page and try again." };

  const queued = await enqueueStaffMessage({
    channel: "whatsapp",
    key: digits,
    message: { type: "text", text },
    clientIdempotencyKey: staffReplyIdempotencyKey({
      compositionId,
      channel: "whatsapp",
      key: digits,
      body: text,
    }),
    body: text,
    contactId,
    leadId,
    actorId: user.id,
    // Ownership, history, the delivery intent and the trail commit together.
    // Nothing here is left as a follow-up await that an interrupted request can
    // skip — least of all pausing the bot, which a retry could never repair
    // because a retry recognises the duplicate and stops.
    audit: {
      action: "whatsapp.sent",
      summary: `WhatsApp sent to +${digits}: “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
      user,
    },
  });

  // Best-effort immediate drain so the reply leaves now rather than on the next
  // cron tick; the worker owns retries, ordering and dead-lettering if it fails.
  // Its result is deliberately not the answer — a drain covers the whole
  // conversation, and what this person needs to know is what happened to THEIR
  // message.
  await flushBotOutboxConversation("whatsapp", digits).catch(() => {});

  revalidatePath(String(formData.get("revalidate") ?? "/"));

  /**
   * The truth about this message, read back after the drain.
   *
   * Answering "Sent ✓" the moment the row was written — which is what this did,
   * on both the new and the duplicate path — reports a send that may not have
   * happened. That is worse than reporting a failure: it ends the person's
   * attention on the conversation, and the customer never hears from them again.
   *
   * The duplicate path reads the same state, so a resubmission is told what
   * became of the message it is a duplicate OF, rather than being congratulated
   * for sending nothing.
   */
  if (!queued.communicationId) return { ok: "Queued — sending…" };
  const state = (await deliveryStateForMessages([queued.communicationId])).get(queued.communicationId);
  return sendOutcomeMessage(state);
}
