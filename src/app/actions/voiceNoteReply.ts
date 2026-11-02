"use server";

import { prisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { accessibleInboxWhere, requirePermission } from "@/lib/permissions";
import { aiVoiceNoteReply } from "@/lib/ai";
import { voiceNoteSuggestion } from "@/lib/voiceNoteReply";

/**
 * "Summarise + suggest a reply" on a customer's WhatsApp voice note (round 2, item 6). The latest transcribed voice
 * note in a conversation THIS person may open (accessibleInboxWhere, as the inbox reads it), with the few messages
 * before it. Nothing is sent and nothing is saved: the reply goes into their reply box to edit and send themselves.
 * Runs only when pressed, so it spends AI credit only then.
 */
export async function suggestVoiceNoteReply(conversationId: string, messageId: string): Promise<{ ok: true; summary: string; reply: string } | { ok: false; error: string }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("inbox.reply");
    const scope = await accessibleInboxWhere(user);
    // Only the voice note the button was shown for, while it is still the customer's latest message — before the AI
    // and again after it (voiceNoteSuggestion).
    return voiceNoteSuggestion(messageId, {
      recent: () => prisma.communication.findMany({
        where: { AND: [scope, { conversationId, type: "whatsapp" }] },
        orderBy: { occurredAt: "desc" },
        take: 8,
        select: { id: true, direction: true, body: true },
      }),
      ai: aiVoiceNoteReply,
    });
  });
}
