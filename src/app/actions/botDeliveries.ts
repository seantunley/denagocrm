"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import {
  flushBotOutboxConversation,
  requeueDeadConversation,
  requeueFailedMessage,
  retriedMessageOutcome,
} from "@/lib/botOutbox";

const BOT_CHANNELS = new Set(["whatsapp", "messenger", "instagram", "telegram"]);

/**
 * Send the requeued message now and say what ACTUALLY happened to it.
 *
 * The requeue's lock ends with its transaction, so a person can take the
 * conversation over before the send; the worker's fence then withdraws the
 * message (keeping the incident — see RETRY_SUPERSEDED). Reporting "Sending
 * again" off the requeue alone said so over nothing (re-review of #733).
 */
async function sendAndReport(channel: string, key: string, headId: string) {
  await flushBotOutboxConversation(channel, key).catch(() => {});
  revalidatePath("/inbox");
  const result = await retriedMessageOutcome(headId);
  if (result === "superseded") refuse("A person took this conversation over before it went out, so it wasn't sent again — reply to the customer yourself.");
  if (result === "failed") refuse("It failed again — it's still listed with the reason. Reply to the customer another way.");
  return { success: result === "sent" ? "Sent" : "Queued — it will go out shortly" };
}

/**
 * Retry a conversation whose last message died (gap audit #31). The outbox
 * decides what may be resent — see requeueDeadConversation.
 */
export async function retryDeadBotConversation(channel: string, key: string) {
  return asActionResult(async () => {
    const user = await requirePermission("inbox.reply");
    if (!BOT_CHANNELS.has(channel) || !key) refuse("That conversation can't be retried from here.");
    const { outcome, headId } = await requeueDeadConversation(channel, key);
    if (outcome === "permanent") refuse("Sending again won't help — reply to the customer another way, or wait for them to write.");
    if (outcome === "not_parked" || !headId) refuse("Someone already picked this conversation up — refresh the inbox.");
    // The outbox id/channel, not the key: on WhatsApp the key is the phone number.
    await logAudit({ action: "bot.delivery_retried", summary: `Retried a failed ${channel} message (${headId})`, user });
    return sendAndReport(channel, key, headId);
  });
}

/**
 * Retry one failed message that did not park its conversation — a staff reply,
 * or one the provider accepted and reported failed later. The conversation's
 * owner is left alone; see UNPARKED_FAILURE / requeueFailedMessage.
 */
export async function retryFailedMessage(outboxId: string) {
  return asActionResult(async () => {
    const user = await requirePermission("inbox.reply");
    if (!outboxId) refuse("That message can't be retried from here.");
    const { outcome, channel, key, headId } = await requeueFailedMessage(outboxId);
    if (outcome === "permanent") refuse("Sending again won't help — reply to the customer another way, or wait for them to write.");
    if (outcome === "human_owned") refuse("A person has taken this conversation over, so the bot's message won't be sent again — reply to the customer yourself.");
    if (outcome === "not_parked" || !channel || !key || !headId) refuse("This message was already sent again — refresh the inbox.");
    await logAudit({ action: "bot.delivery_retried", summary: `Retried a failed ${channel} message (${outboxId})`, user });
    return sendAndReport(channel, key, headId);
  });
}
