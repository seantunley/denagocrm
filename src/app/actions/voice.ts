"use server";

import { requireAnyPermission, requirePermission, canAccessContact, canAccessLead } from "@/lib/permissions";
import { ASK_LIMIT_MESSAGE, ASSISTANT_PERMISSIONS, assistantVoiceAllowed } from "@/lib/assistantUser";
import { withActingStaffScope } from "@/lib/actingScope";
import { transcribeVoiceChecked } from "@/lib/transcribe";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { notHeard } from "@/lib/voiceNotHeard";
import { codexRespond, isCodexConnected } from "@/lib/codex";
import { johannesburgDateKey } from "@/lib/activityDay";
import { logError } from "@/lib/errorLog";
import { safeCodexError } from "@/lib/codexErrors";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { DEBRIEF_INSTRUCTIONS, parseDebrief, plainDebrief, type DebriefDraft } from "@/lib/voiceDebrief";

/** ~3 minutes of opus is well under this; anything bigger isn't a voice note. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** A RECORDED CALL (up to CALL_RECORDING_SECONDS at 32 kbps ≈ 3.6 MB; Safari's AAC runs larger) — under the 16 MB action limit. */
const MAX_CALL_AUDIO_BYTES = 15 * 1024 * 1024;
/** A typed or pasted call note, before it is written up. */
const MAX_TYPED_NOTES = 20_000;

type Heard = { ok: true; text: string } | { ok: false; error: string };

/**
 * The recording → text. The audio goes to the transcriber and is dropped: it is
 * never written to storage, the database or a log (POPIA, and the no-client-data
 * logging rule). Only the text comes back. `call`: a recorded phone call, so longer.
 */
async function hear(formData: FormData, call = false): Promise<Heard> {
  const audio = formData.get("audio");
  if (!(audio instanceof File) || audio.size === 0) return { ok: false, error: "Nothing was recorded — try again." };
  if (audio.size > (call ? MAX_CALL_AUDIO_BYTES : MAX_AUDIO_BYTES)) {
    return { ok: false, error: call ? "That recording is too long — keep a call under 15 minutes." : "That recording is too long — keep it under three minutes." };
  }
  if (!audio.type.startsWith("audio/") && !audio.type.startsWith("video/webm")) {
    return { ok: false, error: "That isn't a voice recording." };
  }
  const heard = await transcribeVoiceChecked(Buffer.from(await audio.arrayBuffer()), audio.type, call ? { timeoutMs: 180_000 } : {});
  if (heard && "text" in heard) return { ok: true, text: heard.text };
  return { ok: false, error: notHeard(heard, await isElevenLabsConfigured()) };
}

/** Speech → text for "Ask the CRM". */
export async function transcribeQuestion(formData: FormData): Promise<Heard> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    // Part of Ask the CRM, so behind the same module as asking does — checked
    // here, before any audio is sent, or a direct call would spend the
    // workspace's ElevenLabs credit with the feature switched off.
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    // The person's one ask limit, before any audio leaves: a direct call in a
    // loop would otherwise spend transcription credit without end.
    if (!(await assistantVoiceAllowed(user.id))) return { ok: false, error: ASK_LIMIT_MESSAGE };
    return hear(formData);
  });
}

type Drafted = { ok: true; draft: DebriefDraft; summarised: boolean } | { ok: false; error: string };

/** The deal or customer the call is logged on — one, and one this person may open. Null when not. */
async function callTarget(user: Awaited<ReturnType<typeof requirePermission>>, formData: FormData) {
  const leadId = String(formData.get("leadId") ?? "");
  const contactId = String(formData.get("contactId") ?? "");
  if (Boolean(leadId) === Boolean(contactId)) return null;
  return (leadId ? await canAccessLead(user, leadId) : await canAccessContact(user, contactId)) ? { leadId, contactId } : null;
}

/** The words of a call → a draft: summary, notes, next step and follow-up date. Never saves. */
async function writeUp(words: string): Promise<Drafted> {
  // The ChatGPT summary is part of Automation & AI; with it off, the person
  // still gets their words back as a plain draft.
  if (!(await isModuleEnabled("automation")) || !(await isCodexConnected())) {
    return { ok: true, draft: plainDebrief(words), summarised: false };
  }
  const reply = await codexRespond({
    instructions: DEBRIEF_INSTRUCTIONS,
    prompt: words,
    reasoningEffort: "low",
    verbosity: "low",
    timeoutMs: 45_000,
  });
  const today = johannesburgDateKey(new Date());
  const draft = "error" in reply ? null : parseDebrief(reply.text, words, today);
  if (!draft) {
    // A reason only — never the transcript.
    await logError("voice-debrief", "summary step failed", "error" in reply ? safeCodexError(reply.error) : "unusable reply");
    return { ok: true, draft: plainDebrief(words), summarised: false };
  }
  return { ok: true, draft, summarised: true };
}

/**
 * A call or visit — dictated afterwards, or the call itself recorded (`call=1`, up to 15 minutes) — → a DRAFT
 * activity for the person to check, on a deal (`leadId`) or a customer (`contactId`). Saves nothing:
 * logVoiceDebrief does that, after they press Save. The audio is transcribed and dropped.
 */
export async function draftVoiceDebrief(formData: FormData): Promise<Drafted> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("activities.manage");
    if (!(await callTarget(user, formData))) return { ok: false, error: "You don't have access to that customer or deal." };
    if (!(await assistantVoiceAllowed(user.id))) return { ok: false, error: ASK_LIMIT_MESSAGE };
    const heard = await hear(formData, formData.get("call") === "1");
    if (!heard.ok) return heard;
    return writeUp(heard.text);
  });
}

/** Typed or pasted call notes → the same draft as a recording. Saves nothing. */
export async function draftTypedDebrief(formData: FormData): Promise<Drafted> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("activities.manage");
    if (!(await callTarget(user, formData))) return { ok: false, error: "You don't have access to that customer or deal." };
    const words = String(formData.get("text") ?? "").trim();
    if (!words) return { ok: false, error: "Type what was said first." };
    if (words.length > MAX_TYPED_NOTES) return { ok: false, error: "That's too long — keep the notes under 20,000 characters." };
    if (!(await assistantVoiceAllowed(user.id))) return { ok: false, error: ASK_LIMIT_MESSAGE };
    return writeUp(words);
  });
}
