import type { SttRefusal } from "./elevenlabs";

/**
 * Why a recording came back with no words, in words that point at the real fix.
 * A refused key used to look exactly like a silent recording (2026-10-07: every
 * recording failed for a key without Speech to Text, and the person was sent to
 * check their microphone).
 */
export function notHeard(refusal: SttRefusal | null, configured: boolean): string {
  if (refusal?.refused === "permission") {
    return "The ElevenLabs key isn't allowed to transcribe — in ElevenLabs, edit the API key and tick Speech to Text (or use a new key in Settings → Integrations).";
  }
  if (refusal?.refused === "key") return "ElevenLabs didn't accept the key — check it in Settings → Integrations.";
  return configured
    ? "Couldn't hear any words — check the right microphone is picked and not muted (the mic icon in the address bar), then try again."
    : "Voice isn't set up — add the ElevenLabs key in Settings → Integrations.";
}
