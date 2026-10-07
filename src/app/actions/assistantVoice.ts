"use server";

import { requireAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { prisma } from "@/lib/db";
import { ASSISTANT_PERMISSIONS, VOICE_REPLY_LIMIT_MESSAGE, assistantVoiceReplyAllowed } from "@/lib/assistantUser";
import { assistantVoiceRepliesOn, synthesiseAnswer } from "@/lib/assistantVoice";

export type SpokenAnswerResult =
  | { ok: true; audio: string }
  /** `off`: listening isn't available in this workspace — the button hides itself. */
  | { ok: false; error: string; off?: boolean };

/**
 * 🔊 Listen, under an answer in the CRM: the spoken version of ONE of the
 * caller's own answers, made only when they press it. Same gate as asking
 * (assistant permission, Automation & AI on), plus the owner's voice switch and
 * the person's hourly cap — all checked before anything is sent to ElevenLabs,
 * because every character costs. The audio goes back as a data URL for an
 * <audio> element and is never stored.
 */
export async function speakAssistantAnswer(turnId: string): Promise<SpokenAnswerResult> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, off: true, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    if (!(await assistantVoiceRepliesOn())) {
      return { ok: false, off: true, error: "Listening to answers isn't switched on for this workspace." };
    }
    // The caller's OWN turn, or nothing: a turn id from someone else's
    // conversation reads exactly like one that doesn't exist.
    const turn = await prisma.assistantTurn.findFirst({ where: { id: String(turnId), userId: user.id }, select: { answer: true } });
    if (!turn) return { ok: false, error: "That answer isn't available any more." };
    if (!(await assistantVoiceReplyAllowed(user.id))) return { ok: false, error: VOICE_REPLY_LIMIT_MESSAGE };
    const audio = await synthesiseAnswer(turn.answer);
    if (audio === "unspeakable") return { ok: false, error: "This answer can't be read aloud — it's in a language the voice doesn't speak." };
    if (audio === "failed") return { ok: false, error: "Couldn't make the audio just now — try again in a minute." };
    return { ok: true, audio: `data:${audio.contentType};base64,${audio.buffer.toString("base64")}` };
  });
}
