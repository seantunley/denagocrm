"use server";

import { prisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { accessibleInboxWhere, requirePermission } from "@/lib/permissions";
import { aiVoiceNoteReply } from "@/lib/ai";
import { voiceNoteTranscript } from "@/lib/voiceNoteReply";

/**
 * "Summarise + suggest a reply" on a customer's WhatsApp voice note (round 2, item 6). The latest transcribed voice
 * note in a conversation THIS person may open (accessibleInboxWhere, as the inbox reads it), with the few messages
 * before it. Nothing is sent and nothing is saved: the reply goes into their reply box to edit and send themselves.
 * Runs only when pressed, so it spends AI credit only then.
 */
export async function suggestVoiceNoteReply(conversationId: string): Promise<{ ok: true; summary: string; reply: string } | { ok: false; error: string }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("inbox.reply");
    const scope = await accessibleInboxWhere(user);
    const recent = await prisma.communication.findMany({
      where: { AND: [scope, { conversationId, type: "whatsapp" }] },
      orderBy: { occurredAt: "desc" },
      take: 8,
      select: { direction: true, body: true },
    });
    const at = recent.findIndex((m) => m.direction === "inbound" && voiceNoteTranscript(m.body));
    if (at === -1) return { ok: false, error: "There's no transcribed voice note from the customer here." };
    const result = await aiVoiceNoteReply({
      transcript: voiceNoteTranscript(recent[at].body)!,
      history: recent.slice(at + 1).reverse().map((m) => ({ from: m.direction === "outbound" ? "us" : "customer", text: m.body })),
    });
    return "error" in result ? { ok: false, error: result.error } : { ok: true, ...result };
  });
}
