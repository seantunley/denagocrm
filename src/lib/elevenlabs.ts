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
const DEFAULT_STT_MODEL = "scribe_v1";
const DEFAULT_TTS_MODEL = "eleven_turbo_v2_5"; // fast + cheap, good for chat replies

export async function isElevenLabsConfigured(): Promise<boolean> {
  return Boolean(await getSetting("ELEVENLABS_API_KEY"));
}

/** Transcribe an audio clip to text. Returns null if unconfigured or on failure. */
export async function elevenLabsSTT(buffer: Buffer, contentType = "audio/ogg"): Promise<string | null> {
  const apiKey = await getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) return null;
  const model = (await getSetting("ELEVENLABS_STT_MODEL")) || DEFAULT_STT_MODEL;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), "voice.ogg");
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
    return text || null;
  } catch (e) {
    await logError("elevenlabs-stt", e);
    return null;
  }
}

/**
 * Synthesise speech from text. Returns MP3 bytes (audio/mpeg) or null. MP3 sends
 * fine as a WhatsApp audio message; a true PTT waveform would need ogg/opus, which
 * needs transcoding we don't have serverless — mp3 is the pragmatic v1.
 */
export async function elevenLabsTTS(text: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const apiKey = await getSetting("ELEVENLABS_API_KEY");
  const voiceId = await getSetting("ELEVENLABS_VOICE_ID");
  if (!apiKey || !voiceId) return null;
  const model = (await getSetting("ELEVENLABS_TTS_MODEL")) || DEFAULT_TTS_MODEL;
  const clean = text.trim();
  if (!clean) return null;
  try {
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text: clean, model_id: model }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      await logError("elevenlabs-tts", `TTS ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length ? { buffer, contentType: "audio/mpeg" } : null;
  } catch (e) {
    await logError("elevenlabs-tts", e);
    return null;
  }
}
