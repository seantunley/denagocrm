"use server";

import { revalidatePath } from "next/cache";
import { canAccessContact, canAccessLead, requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { waDigits } from "@/lib/whatsapp";
import { enqueueStaffMessage, flushBotOutboxConversation } from "@/lib/botOutbox";
import { pauseBotConversation } from "@/lib/botConversationControl";

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
   * the customer received it twice. The reply box holds one idempotency key per
   * composed message and keeps it across its own retries, so a resubmission
   * resolves to the row that already exists instead of sending a second copy.
   */
  const idempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim();
  if (!idempotencyKey) return { error: "This reply is missing its send key — reload the page and try again." };

  const queued = await enqueueStaffMessage({
    channel: "whatsapp",
    key: digits,
    message: { type: "text", text },
    clientIdempotencyKey: idempotencyKey,
    body: text,
    contactId,
    leadId,
    actorId: user.id,
  });
  if (!queued.created) {
    // Already accepted under this key. Saying "Sent ✓" is the truth: the message
    // is queued or delivered, and this submission must not add another.
    revalidatePath(String(formData.get("revalidate") ?? "/"));
    return { ok: "Sent ✓" };
  }

  // Best-effort immediate drain so the reply leaves now rather than on the next
  // cron tick; the worker owns retries, ordering and dead-lettering if it fails.
  await flushBotOutboxConversation("whatsapp", digits).catch(() => {});
  // A human reply is an ownership decision, not merely a timestamp heuristic.
  // Pause the same BotSession the flow runtime checks on the next inbound turn.
  await pauseBotConversation({ channel: "whatsapp", key: digits }, 12);
  await logAudit({
    action: "whatsapp.sent",
    summary: `WhatsApp sent to +${digits}: “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`,
    contactId,
    leadId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
  return { ok: "Sent ✓" };
}
