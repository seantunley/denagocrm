"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { flushBotOutboxConversation, requeueDeadConversation, requeueFailedMessage } from "@/lib/botOutbox";

const BOT_CHANNELS = new Set(["whatsapp", "messenger", "instagram", "telegram"]);

/**
 * Retry a conversation whose last message died (gap audit #31). The outbox
 * decides what may be resent — see requeueDeadConversation.
 */
export async function retryDeadBotConversation(channel: string, key: string) {
  return asActionResult(async () => {
    const user = await requirePermission("inbox.reply");
    if (!BOT_CHANNELS.has(channel) || !key) refuse("That conversation can't be retried from here.");
    const outcome = await requeueDeadConversation(channel, key);
    if (outcome === "permanent") refuse("Sending again won't help — reply to the customer another way, or wait for them to write.");
    if (outcome === "not_parked") refuse("Someone already picked this conversation up — refresh the inbox.");
    await flushBotOutboxConversation(channel, key).catch(() => {});
    // The outbox id/channel, not the key: on WhatsApp the key is the phone number.
    await logAudit({ action: "bot.delivery_retried", summary: `Retried a failed ${channel} message`, user });
    revalidatePath("/inbox");
    return { success: "Sending again" };
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
    const { outcome, channel, key } = await requeueFailedMessage(outboxId);
    if (outcome === "permanent") refuse("Sending again won't help — reply to the customer another way, or wait for them to write.");
    if (outcome === "human_owned") refuse("A person has taken this conversation over, so the bot's message won't be sent again — reply to the customer yourself.");
    if (outcome === "not_parked" || !channel || !key) refuse("This message was already sent again — refresh the inbox.");
    await flushBotOutboxConversation(channel, key).catch(() => {});
    await logAudit({ action: "bot.delivery_retried", summary: `Retried a failed ${channel} message (${outboxId})`, user });
    revalidatePath("/inbox");
    return { success: "Sending again" };
  });
}
