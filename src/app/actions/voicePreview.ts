"use server";

import { requireTenantOwner } from "@/lib/auth";
import { withActingStaffScope } from "@/lib/actingScope";
import { getSetting } from "@/lib/settings";
import { elevenLabsTTS } from "@/lib/elevenlabs";
import { PRONUNCIATIONS_KEY, parsePronunciations, speakableText } from "@/lib/spokenText";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";

/** What the sample says — written as DAX would write it, so the preview also shows what the spoken clean-up does. */
const SAMPLE = (name: string) =>
  `Hi, it's ${name}. Q-1030 for the Rover XL is ready: R 185 000,00, valid until Fri 6 Nov. Shall I send you the PDF?`;
const SAMPLE_AF = (name: string) =>
  `Hallo, dis ${name}. Die kwotasie vir die Rover XL is gereed. Moet ek vir jou die PDF stuur?`;

/**
 * ▶ Play a sample, in Settings → Integrations → ElevenLabs (Sean, 2026-11-02: choose a voice by ear). The OWNER
 * only, with the workspace's own key, model, speed and pronunciations; `voiceId` lets a voice be heard before it is
 * saved. The audio goes back as a data URL and is never stored.
 */
export async function previewVoice(voiceId: string, language: "en" | "af" = "en"): Promise<{ ok: true; audio: string } | { ok: false; error: string }> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const id = String(voiceId ?? "").trim();
    if (id && !/^[A-Za-z0-9]{8,40}$/.test(id)) return { ok: false, error: "That isn't a voice ID." };
    const [profileRaw, pronunciations] = await Promise.all([getSetting(ASSISTANT_PROFILE_KEY), getSetting(PRONUNCIATIONS_KEY)]);
    const name = parseProfile(profileRaw).name;
    const afrikaans = language === "af";
    const text = speakableText(afrikaans ? SAMPLE_AF(name) : SAMPLE(name), { afrikaans, pronunciations: parsePronunciations(pronunciations) });
    const audio = await elevenLabsTTS(text, { language, ...(id ? { voiceId: id } : {}) });
    if (!audio) return { ok: false, error: "Couldn't make the sample — check the ElevenLabs key and the voice, then try again." };
    return { ok: true, audio: `data:${audio.contentType};base64,${audio.buffer.toString("base64")}` };
  });
}
