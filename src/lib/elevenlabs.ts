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
 * ELEVEN V4 (Sean, 2026-11-02: "sounds very mechanical"; "Change to ElevenLabs V4"): ElevenLabs' newest and most
 * natural model, and it speaks Afrikaans too — so both languages are the same voice. eleven_turbo_v2_5, the old
 * default, is deprecated.
 *
 * V4 IS NOT ON THE TEXT TO SPEECH ENDPOINT. It is served by the Text to Dialogue API — POST /v1/text-to-dialogue,
 * one input with our one voice — and v4 Turbo only by the Text to Dialogue WebSocket (models page and API reference,
 * checked 2026-11-02; review of #935 found the first version sending v4 Turbo to Text to Speech, where it would
 * have failed every time). So each model says which endpoint it is on, and the request is built for that.
 */
export const DEFAULT_TTS_MODEL = "eleven_v4";
/**
 * The voice models a workspace may choose: which endpoint each is on, whether it speaks Afrikaans, and whether it
 * takes the speed setting. Settings per model (ElevenLabs' docs, 2026-11-02): v4 takes Stability and Similarity
 * only ("Style and Speed sliders are not available in Eleven v4"); v3 has no Speed, Similarity or Speaker Boost;
 * the v2 models take them all.
 */
export type TtsModel = { id: string; label: string; afrikaans: boolean; endpoint: "dialogue" | "speech"; speed: boolean };
export const TTS_MODELS: readonly TtsModel[] = [
  { id: "eleven_v4", label: "Eleven v4 — most natural; speaks Afrikaans (recommended)", afrikaans: true, endpoint: "dialogue", speed: false },
  { id: "eleven_v3", label: "Eleven v3 — natural; speaks Afrikaans", afrikaans: true, endpoint: "speech", speed: false },
  { id: "eleven_multilingual_v2", label: "Multilingual v2 — steady; Afrikaans uses v4", afrikaans: false, endpoint: "speech", speed: true },
  { id: "eleven_flash_v2_5", label: "Flash v2.5 — fastest, flatter; Afrikaans uses v4", afrikaans: false, endpoint: "speech", speed: true },
];
/**
 * When the chosen model is refused (an account or plan without it), or gives back something that is not a voice
 * note: Eleven v3 on the Text to Speech endpoint — natural, both languages, long available. Said in the log.
 */
export const FALLBACK_TTS_MODEL = "eleven_v3";
/** Speaking speed (ElevenLabs: 1 is normal) — only for a model that takes it. */
export const VOICE_SPEEDS = ["0.9", "0.95", "1", "1.05", "1.1"] as const;
const VOICE_SEED = 20261102;

const modelOf = (modelId: string): TtsModel => TTS_MODELS.find((m) => m.id === modelId) ?? TTS_MODELS.find((m) => m.id === FALLBACK_TTS_MODEL)!;
/** Does this model take the speed setting? (Settings shows the control only then.) */
export const modelTakesSpeed = (modelId: string): boolean => modelOf(modelId).speed;

/**
 * The exact request for one model — its endpoint, and only the settings it takes:
 *  - v4 (Text to Dialogue): one input with the voice; `settings` stability 0.5 and similarity 0.75 (the defaults —
 *    tuned by ear once heard); the language; the same seed every time.
 *  - v3 (Text to Speech): stability 0.5 ("Natural") only; the language; the seed.
 *  - the v2 models (Text to Speech): a little below the default steadiness so it varies like speech, a touch of
 *    style, speaker boost and the owner's speed; the language except on Multilingual v2, which doesn't take it.
 * Always OGG/Opus 48 kHz — WhatsApp's own voice-note format.
 */
export function ttsRequest(modelId: string, voiceId: string, text: string, language: "en" | "af", speed: number): { url: string; body: Record<string, unknown> } {
  const model = modelOf(modelId);
  const format = "output_format=opus_48000_64";
  if (model.endpoint === "dialogue") {
    return {
      url: `${API}/text-to-dialogue?${format}`,
      body: { inputs: [{ text, voice_id: voiceId }], model_id: model.id, language_code: language, seed: VOICE_SEED, settings: { stability: 0.5, similarity: 0.75 } },
    };
  }
  const voice_settings = model.speed
    ? { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed }
    : { stability: 0.5 };
  return {
    url: `${API}/text-to-speech/${encodeURIComponent(voiceId)}?${format}`,
    body: { text, model_id: model.id, ...(model.id === "eleven_multilingual_v2" ? {} : { language_code: language }), seed: VOICE_SEED, voice_settings },
  };
}

/** Is this an OGG/Opus file — what WhatsApp needs for a voice note? (An Ogg stream starts "OggS".) */
export const isOggVoiceNote = (bytes: Uint8Array): boolean =>
  bytes.length > 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;

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
  // One attempt with one model: the request built for its endpoint, and only an OGG/Opus file counts as a voice note.
  const speak = async (modelId: string): Promise<{ buffer: Buffer } | { status: number; detail: string }> => {
    const { url, body } = ttsRequest(modelId, voiceId, clean, language, speed);
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/ogg" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { status: res.status, detail: (await res.text().catch(() => "")).slice(0, 200) };
    const buffer = Buffer.from(await res.arrayBuffer());
    return isOggVoiceNote(buffer) ? { buffer } : { status: res.status, detail: `not an OGG voice note (${res.headers.get("content-type") ?? "no type"}, ${buffer.length} bytes)` };
  };
  try {
    let result = await speak(model);
    // The chosen model refused (a plan without it, a model retired) or what came back is not a voice note: once
    // more with Eleven v3 on Text to Speech, so the voice note still goes — said in the log (the reason only, never
    // the text), so the owner can pick a model that works. A refused KEY (401) is not retried: v3 would be too.
    if ("status" in result && model !== FALLBACK_TTS_MODEL && (result.status === 200 || [400, 403, 404, 422].includes(result.status))) {
      await logError("elevenlabs-tts", `TTS ${result.status} with ${model}; retrying with ${FALLBACK_TTS_MODEL}`, result.detail);
      result = await speak(FALLBACK_TTS_MODEL);
    }
    if ("status" in result) {
      await logError("elevenlabs-tts", `TTS ${result.status}`, result.detail);
      return null;
    }
    return { buffer: result.buffer, contentType: "audio/ogg" };
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
