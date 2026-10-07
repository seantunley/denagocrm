import "server-only";
import { getSetting } from "./settings";
import { canSynthesizeVoice, elevenLabsTTS } from "./elevenlabs";
import type { VoiceLanguage } from "./voiceLanguage";
import { ASSISTANT_VOICE_REPLIES_KEY, spokenAnswer, voiceLanguageFor, voiceRepliesSwitchOn } from "./assistantVoiceRules";

/*
 * DAX speaking its answer — the ElevenLabs half. Used by the WhatsApp reply
 * (a voice note back for a voice note) and the CRM's Listen button. The audio
 * is made on demand and handed straight on: never stored, never logged.
 */

/** The owner's switch is on AND a voice is set up — the switch alone would promise audio we can't make. */
export async function assistantVoiceRepliesOn(): Promise<boolean> {
  return voiceRepliesSwitchOn(await getSetting(ASSISTANT_VOICE_REPLIES_KEY)) && (await canSynthesizeVoice());
}

export type SpokenAudio = { buffer: Buffer; contentType: string };

/**
 * The spoken version of `answer` as OGG/Opus, or why not: "unspeakable" when
 * no model speaks its language (text only, not a failure), "failed" when
 * ElevenLabs gave nothing (it logs its own reason).
 */
export async function synthesiseAnswer(answer: string, heard?: VoiceLanguage | null): Promise<SpokenAudio | "unspeakable" | "failed"> {
  const voice = voiceLanguageFor(answer, heard);
  const spoken = spokenAnswer(answer);
  if (!voice || !spoken) return "unspeakable";
  return (await elevenLabsTTS(spoken, { model: voice.ttsModel })) ?? "failed";
}
