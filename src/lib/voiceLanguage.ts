/**
 * What language a customer's voice note was in, and whether we can answer in a
 * voice in that language.
 *
 * ElevenLabs Scribe transcribes Afrikaans well and Zulu/Xhosa moderately, and
 * reports the language it heard. Speaking back is narrower (docs, 2026-10): only
 * Eleven v3 speaks Afrikaans, and no model speaks Zulu, Xhosa or the other South
 * African languages. So: Afrikaans → reply in Afrikaans, voiced with v3; the
 * unvoiceable ones → reply in that language, as TEXT; English and everything
 * else → unchanged.
 */

export type VoiceLanguage = {
  /** ISO 639-3, as Scribe uses it. */
  code: string;
  name: string;
  /** Can a voice reply be synthesised in this language at all? */
  speakable: boolean;
  /** TTS model to use instead of the workspace default, when one is needed. */
  ttsModel?: string;
};

/** Afrikaans is the one South African language a model can voice. */
const AFRIKAANS: VoiceLanguage = { code: "afr", name: "Afrikaans", speakable: true, ttsModel: "eleven_v3" };

/** Transcribed, but no TTS model speaks them: reply as text in the same language. */
const TEXT_ONLY: Record<string, string> = {
  zul: "isiZulu",
  xho: "isiXhosa",
  sot: "Sesotho",
  tsn: "Setswana",
  nso: "Sepedi",
  ssw: "siSwati",
  ven: "Tshivenda",
  tso: "Xitsonga",
  nbl: "isiNdebele",
};

/** Scribe has returned both two- and three-letter codes; accept either. */
const TWO_TO_THREE: Record<string, string> = {
  af: "afr", zu: "zul", xh: "xho", st: "sot", tn: "tsn", ss: "ssw", ve: "ven", ts: "tso", nr: "nbl", en: "eng",
};

/**
 * The language to act on, or null to change nothing (English, unknown, or a
 * low-confidence guess — a misheard short clip must not flip the reply language).
 */
export function voiceLanguage(rawCode: string | null | undefined, probability?: number | null): VoiceLanguage | null {
  if (!rawCode) return null;
  if (probability != null && probability < 0.6) return null;
  const lower = rawCode.trim().toLowerCase();
  const code = TWO_TO_THREE[lower] ?? lower;
  if (code === "afr") return AFRIKAANS;
  const textOnly = TEXT_ONLY[code];
  if (textOnly) return { code, name: textOnly, speakable: false };
  return null;
}
