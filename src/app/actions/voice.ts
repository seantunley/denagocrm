"use server";

import { requireAnyPermission, requirePermission, canAccessLead } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { transcribeVoice } from "@/lib/transcribe";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { codexRespond, isCodexConnected } from "@/lib/codex";
import { johannesburgDateKey } from "@/lib/activityDay";
import { logError } from "@/lib/errorLog";
import { DEBRIEF_INSTRUCTIONS, parseDebrief, plainDebrief, type DebriefDraft } from "@/lib/voiceDebrief";

/** ~3 minutes of opus is well under this; anything bigger isn't a voice note. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

type Heard = { ok: true; text: string } | { ok: false; error: string };

/**
 * The recording → text. The audio goes to the transcriber and is dropped: it is
 * never written to storage, the database or a log (POPIA, and the no-client-data
 * logging rule). Only the text comes back.
 */
async function hear(formData: FormData): Promise<Heard> {
  const audio = formData.get("audio");
  if (!(audio instanceof File) || audio.size === 0) return { ok: false, error: "Nothing was recorded — try again." };
  if (audio.size > MAX_AUDIO_BYTES) return { ok: false, error: "That recording is too long — keep it under three minutes." };
  if (!audio.type.startsWith("audio/") && !audio.type.startsWith("video/webm")) {
    return { ok: false, error: "That isn't a voice recording." };
  }
  const text = await transcribeVoice(Buffer.from(await audio.arrayBuffer()), audio.type);
  if (text) return { ok: true, text };
  return {
    ok: false,
    error: (await isElevenLabsConfigured())
      ? "Couldn't make out the recording — try again somewhere quieter."
      : "Voice isn't set up — add the ElevenLabs key in Settings → Integrations.",
  };
}

/** Speech → text for "Ask the CRM". */
export async function transcribeQuestion(formData: FormData): Promise<Heard> {
  return withActingStaffScope(async () => {
    await requireAnyPermission(
      "leads.view_all", "leads.view_owned",
      "quotes.view_all", "quotes.view_owned",
      "activities.view", "activities.manage",
    );
    return hear(formData);
  });
}

/**
 * A spoken call/visit debrief → a DRAFT activity for the person to check. Saves
 * nothing: logVoiceDebrief does that, after they press Save.
 */
export async function draftVoiceDebrief(
  formData: FormData,
): Promise<{ ok: true; draft: DebriefDraft; summarised: boolean } | { ok: false; error: string }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("activities.manage");
    const leadId = String(formData.get("leadId") ?? "");
    if (!leadId || !(await canAccessLead(user, leadId))) return { ok: false, error: "You don't have access to that lead." };
    const heard = await hear(formData);
    if (!heard.ok) return heard;
    if (!(await isCodexConnected())) return { ok: true, draft: plainDebrief(heard.text), summarised: false };
    const reply = await codexRespond({
      instructions: DEBRIEF_INSTRUCTIONS,
      prompt: heard.text,
      reasoningEffort: "low",
      verbosity: "low",
      timeoutMs: 45_000,
    });
    const today = johannesburgDateKey(new Date());
    const draft = "error" in reply ? null : parseDebrief(reply.text, heard.text, today);
    if (!draft) {
      // A reason only — never the transcript.
      await logError("voice-debrief", "summary step failed", "error" in reply ? reply.error : "unusable reply");
      return { ok: true, draft: plainDebrief(heard.text), summarised: false };
    }
    return { ok: true, draft, summarised: true };
  });
}
