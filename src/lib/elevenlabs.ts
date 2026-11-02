import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { TTS_MODEL_KEY, VOICE_SPEED_KEY } from "./voiceSettings";

/**
 * ElevenLabs voice — the single provider for all of our speech:
 *  - speech-to-text  (inbound WhatsApp voice notes → text)
 *  - text-to-speech  (bot replies → a voice note back)
 * Optional: everything degrades to null/no-op when ELEVENLABS_API_KEY isn't set,
 * so callers fall back to text.
 */

const API = "https://api.elevenlabs.io/v1";
// Sensible defaults; overridable in Settings → Integrations → ElevenLabs.
const DEFAULT_STT_MODEL = "scribe_v2"; // current model (scribe_v1 is deprecated)
/**
 * Eleven v4 Turbo (Sean, 2026-11-02: "sounds very mechanical"): the current fast model, ~100 ms, and one that
 * speaks Afrikaans too — so both languages are the same voice. eleven_turbo_v2_5, the old default, is deprecated.
 */
export const DEFAULT_TTS_MODEL = "eleven_v4_turbo";
/** The voice models a workspace may choose (models page, 2026-11-02), and which of them speak Afrikaans. */
export const TTS_MODELS: readonly { id: string; label: string; afrikaans: boolean }[] = [
  { id: "eleven_v4_turbo", label: "Eleven v4 Turbo — natural and quick (recommended)", afrikaans: true },
  { id: "eleven_v4", label: "Eleven v4 — most expressive, a little slower", afrikaans: true },
  { id: "eleven_flash_v2_5", label: "Flash v2.5 — fastest, flatter; no Afrikaans", afrikaans: false },
  { id: "eleven_multilingual_v2", label: "Multilingual v2 — the older steady voice; no Afrikaans", afrikaans: false },
];
/** Tried once when the chosen model is refused (an account without it): the long-standing ones. */
const FALLBACK_TTS_MODEL = { en: "eleven_flash_v2_5", af: "eleven_v3" } as const;
/** Speaking speed (ElevenLabs: 1 is normal). */
export const VOICE_SPEEDS = ["0.9", "0.95", "1", "1.05", "1.1"] as const;
/**
 * How the voice is delivered. A little below the default steadiness (0.5) so it varies like speech; a touch of
 * style; the same seed every time so the same answer sounds the same. Tuned by ear; speed is the owner's.
 */
const VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } as const;
const VOICE_SEED = 20261102;

/** Enough config to transcribe inbound voice notes — needs only the API key. */
export async function isElevenLabsConfigured(): Promise<boolean> {
  return Boolean(await getSetting("ELEVENLABS_API_KEY"));
}

/**
 * Enough config to *send* a voice note back — needs the API key AND a voice.
 * Without a voice, elevenLabsTTS returns null and we'd silently fall back to
 * text, so the voice-reply path must gate on this, not on the key alone.
 */
export async function canSynthesizeVoice(): Promise<boolean> {
  const [key, voiceId] = await Promise.all([
    getSetting("ELEVENLABS_API_KEY"),
    getSetting("ELEVENLABS_VOICE_ID"),
  ]);
  return Boolean(key && voiceId);
}

/** Transcribe an audio clip to text. Returns null if unconfigured or on failure. */
export async function elevenLabsSTT(buffer: Buffer, contentType = "audio/ogg", opts: { keyterms?: readonly string[] } = {}): Promise<string | null> {
  return (await elevenLabsSTTDetailed(buffer, contentType, opts))?.text ?? null;
}

export type Transcript = {
  text: string;
  /** What Scribe heard, as it reports it (e.g. "afr"/"af"); null if not reported. */
  languageCode: string | null;
  languageProbability: number | null;
};

/** As elevenLabsSTT, plus the language Scribe detected and how sure it was. */
export async function elevenLabsSTTDetailed(buffer: Buffer, contentType = "audio/ogg", opts: { keyterms?: readonly string[] } = {}): Promise<Transcript | null> {
  const result = await elevenLabsSTTChecked(buffer, contentType, opts);
  return result && "text" in result ? result : null;
}

/**
 * Why ElevenLabs refused, when it was the KEY: "permission" — a scoped key
 * without Speech to Text ticked (seen 2026-10-07: every recording failed and
 * the person was told to check their microphone); "key" — revoked or wrong.
 */
export type SttRefusal = { refused: "permission" | "key" };

/**
 * Words Scribe should expect (keyterm prompting): the names it would otherwise mis-spell. ElevenLabs' rules — under
 * 50 characters, at most 5 words, none of < > { } [ ] \ — applied here; duplicates dropped; at most
 * MAX_KEYTERMS, because more than 100 makes every clip bill as at least 20 seconds (docs, 2026-11-02).
 */
export const MAX_KEYTERMS = 100;
export function sttKeyterms(words: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words) {
    const term = String(raw ?? "").replace(/[<>{}[\]\\]/g, " ").replace(/\s+/g, " ").trim();
    if (term.length < 2 || term.length >= 50 || term.split(" ").length > 5) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}

/** As elevenLabsSTTDetailed, but says when the key itself was refused. `keyterms`: names to expect (sttKeyterms). */
export async function elevenLabsSTTChecked(buffer: Buffer, contentType = "audio/ogg", opts: { keyterms?: readonly string[] } = {}): Promise<Transcript | SttRefusal | null> {
  const apiKey = await getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) return null;
  const model = (await getSetting("ELEVENLABS_STT_MODEL")) || DEFAULT_STT_MODEL;
  // Name the file for what it is: a browser recording is webm/mp4, not ogg.
  const ext = contentType.includes("webm") ? "webm" : contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : contentType.includes("mpeg") || contentType.includes("mp3") ? "mp3" : "ogg";
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), `voice.${ext}`);
    form.append("model_id", model);
    // Without the "um"s, false starts and background noises (Scribe v2 only): a cleaner question for DAX and a
    // cleaner line on the timeline. The words said are unchanged.
    if (model === "scribe_v2") form.append("no_verbatim", "true");
    // One field per term — as ElevenLabs' own SDK sends them.
    for (const term of sttKeyterms(opts.keyterms ?? [])) form.append("keyterms", term);
    const res = await fetch(`${API}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await logError("elevenlabs-stt", `STT ${res.status}`, body.slice(0, 200));
      if (res.status === 401) return { refused: body.includes("missing_permissions") ? "permission" : "key" };
      return null;
    }
    const json = await res.json();
    const text = String(json?.text ?? "").trim();
    if (!text) return null;
    const probability = Number(json?.language_probability);
    return {
      text,
      languageCode: typeof json?.language_code === "string" ? json.language_code : null,
      languageProbability: Number.isFinite(probability) ? probability : null,
    };
  } catch (e) {
    await logError("elevenlabs-stt", e);
    return null;
  }
}

/**
 * Synthesise speech from text. Returns OGG/Opus bytes (audio/ogg) or null.
 * ElevenLabs' opus_48000_64 output is a mono OGG-Opus stream (verified: bytes
 * start "OggS" + "OpusHead 01 01"), which is exactly WhatsApp's voice-note (PTT)
 * format — so replies render with the real waveform, no transcoding needed. It's
 * also ~40% smaller than the mp3 we used before.
 */
export async function elevenLabsTTS(
  text: string,
  /** The language the text is in ("af" or "en"): passed on, and Afrikaans gets a model that speaks it. `voiceId`: a preview of another voice. */
  opts: { language?: "en" | "af"; voiceId?: string } = {},
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const [apiKey, savedVoice, savedModel, savedSpeed] = await Promise.all([
    getSetting("ELEVENLABS_API_KEY"),
    getSetting("ELEVENLABS_VOICE_ID"),
    getSetting(TTS_MODEL_KEY),
    getSetting(VOICE_SPEED_KEY),
  ]);
  const voiceId = opts.voiceId || savedVoice;
  if (!apiKey || !voiceId) return null;
  const clean = text.trim();
  if (!clean) return null;
  const language = opts.language ?? "en";
  const model = ttsModelFor(savedModel, language);
  const speed = Number((VOICE_SPEEDS as readonly string[]).includes(String(savedSpeed)) ? savedSpeed : "1");
  const speak = (modelId: string) =>
    fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=opus_48000_64`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/ogg" },
      body: JSON.stringify({ text: clean, model_id: modelId, language_code: language, seed: VOICE_SEED, voice_settings: { ...VOICE_SETTINGS, speed } }),
      signal: AbortSignal.timeout(30000),
    });
  try {
    let res = await speak(model);
    // A model this account can't use (or one ElevenLabs retired): once more with the long-standing one, so the
    // voice note still goes — said in the log, so the owner can pick a model that works.
    if (!res.ok && [400, 404, 422].includes(res.status) && model !== FALLBACK_TTS_MODEL[language]) {
      await logError("elevenlabs-tts", `TTS ${res.status} with ${model}; retrying with ${FALLBACK_TTS_MODEL[language]}`, (await res.text().catch(() => "")).slice(0, 200));
      res = await speak(FALLBACK_TTS_MODEL[language]);
    }
    if (!res.ok) {
      await logError("elevenlabs-tts", `TTS ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length ? { buffer, contentType: "audio/ogg" } : null;
  } catch (e) {
    await logError("elevenlabs-tts", e);
    return null;
  }
}

/** The model to speak with: the workspace's choice, or the default — and for Afrikaans always one that speaks it. */
export function ttsModelFor(saved: string | null | undefined, language: "en" | "af"): string {
  const chosen = TTS_MODELS.find((m) => m.id === saved) ?? TTS_MODELS.find((m) => m.id === DEFAULT_TTS_MODEL)!;
  return language === "af" && !chosen.afrikaans ? DEFAULT_TTS_MODEL : chosen.id;
}

/** The voices in the workspace's ElevenLabs account, for the Settings picker. Null when there is no key or the call fails. */
export async function elevenLabsVoices(): Promise<{ id: string; name: string; accent: string | null; category: string | null }[] | null> {
  const apiKey = await getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) return null;
  try {
    const res = await fetch(`${API}/voices`, { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      await logError("elevenlabs-voices", `voices ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { voices?: { voice_id?: unknown; name?: unknown; category?: unknown; labels?: { accent?: unknown } }[] };
    return (json.voices ?? [])
      .filter((v) => typeof v.voice_id === "string" && typeof v.name === "string")
      .map((v) => ({
        id: String(v.voice_id),
        name: String(v.name).slice(0, 80),
        accent: typeof v.labels?.accent === "string" ? v.labels.accent.slice(0, 40) : null,
        category: typeof v.category === "string" ? v.category : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    await logError("elevenlabs-voices", e);
    return null;
  }
}
