import { getSetting } from "./settings";
import { logError } from "./errorLog";

/**
 * ElevenLabs voice — the single provider for all of our speech:
 *  - speech-to-text  (inbound WhatsApp voice notes → text)
 *  - text-to-speech  (bot replies → a voice note back)
 * Optional: everything degrades to null/no-op when ELEVENLABS_API_KEY isn't set,
 * so callers fall back to text.
 */

const API = "https://api.elevenlabs.io/v1";
// Sensible defaults; overridable via settings if ever needed.
const DEFAULT_STT_MODEL = "scribe_v2"; // current model (scribe_v1 still works but is the older one)
const DEFAULT_TTS_MODEL = "eleven_turbo_v2_5"; // fast + cheap, good for chat replies

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
export async function elevenLabsSTT(buffer: Buffer, contentType = "audio/ogg"): Promise<string | null> {
  return (await elevenLabsSTTDetailed(buffer, contentType))?.text ?? null;
}

export type Transcript = {
  text: string;
  /** What Scribe heard, as it reports it (e.g. "afr"/"af"); null if not reported. */
  languageCode: string | null;
  languageProbability: number | null;
};

/** As elevenLabsSTT, plus the language Scribe detected and how sure it was. */
export async function elevenLabsSTTDetailed(buffer: Buffer, contentType = "audio/ogg"): Promise<Transcript | null> {
  const apiKey = await getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) return null;
  const model = (await getSetting("ELEVENLABS_STT_MODEL")) || DEFAULT_STT_MODEL;
  // Name the file for what it is: a browser recording is webm/mp4, not ogg.
  const ext = contentType.includes("webm") ? "webm" : contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : contentType.includes("mpeg") || contentType.includes("mp3") ? "mp3" : "ogg";
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), `voice.${ext}`);
    form.append("model_id", model);
    const res = await fetch(`${API}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      await logError("elevenlabs-stt", `STT ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
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
  /** A model that speaks the reply's language (Afrikaans needs eleven_v3); else the workspace default. */
  opts: { model?: string } = {},
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const apiKey = await getSetting("ELEVENLABS_API_KEY");
  const voiceId = await getSetting("ELEVENLABS_VOICE_ID");
  if (!apiKey || !voiceId) return null;
  const model = opts.model || (await getSetting("ELEVENLABS_TTS_MODEL")) || DEFAULT_TTS_MODEL;
  const clean = text.trim();
  if (!clean) return null;
  try {
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=opus_48000_64`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/ogg",
      },
      body: JSON.stringify({ text: clean, model_id: model }),
      signal: AbortSignal.timeout(30000),
    });
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
