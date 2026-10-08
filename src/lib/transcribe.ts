import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { elevenLabsSTTChecked, elevenLabsSTTDetailed, type SttRefusal, type Transcript } from "./elevenlabs";

/**
 * Transcribes an audio clip (e.g. a WhatsApp voice note) to text. ElevenLabs is
 * our standard voice provider, so it's tried first; OpenAI Whisper is a fallback
 * for existing setups. Returns null if neither is configured or on failure
 * (caller degrades gracefully).
 */
export async function transcribeVoice(
  buffer: Buffer,
  contentType = "audio/ogg"
): Promise<string | null> {
  return (await transcribeVoiceDetailed(buffer, contentType))?.text ?? null;
}

/**
 * As transcribeVoice, plus the language heard. Only ElevenLabs reports it; the
 * Whisper fallback returns the text with no language, which changes nothing.
 */
export async function transcribeVoiceDetailed(
  buffer: Buffer,
  contentType = "audio/ogg"
): Promise<Transcript | null> {
  const viaEleven = await elevenLabsSTTDetailed(buffer, contentType);
  if (viaEleven) return viaEleven;
  const text = await whisperTranscribe(buffer, contentType);
  return text ? { text, languageCode: null, languageProbability: null } : null;
}

/**
 * As transcribeVoice, but when nothing came back says whether ElevenLabs
 * refused the KEY — so the person is told to fix the key, not their microphone.
 */
export async function transcribeVoiceChecked(buffer: Buffer, contentType: string): Promise<{ text: string } | SttRefusal | null> {
  const viaEleven = await elevenLabsSTTChecked(buffer, contentType);
  if (viaEleven && "text" in viaEleven) return { text: viaEleven.text };
  const text = await whisperTranscribe(buffer, contentType);
  return text ? { text } : viaEleven;
}

async function whisperTranscribe(buffer: Buffer, contentType: string): Promise<string | null> {
  const apiKey = await getSetting("OPENAI_API_KEY");
  if (!apiKey) return null;
  try {
    const ext = contentType.includes("mp3")
      ? "mp3"
      : contentType.includes("mp4") || contentType.includes("m4a")
      ? "m4a"
      : contentType.includes("wav")
      ? "wav"
      : contentType.includes("webm")
      ? "webm"
      : "ogg";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), `voice.${ext}`);
    form.append("model", "whisper-1");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      await logError("voice-transcribe", `Whisper ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = await res.json();
    const text = String(json.text ?? "").trim();
    return text || null;
  } catch (e) {
    await logError("voice-transcribe", e);
    return null;
  }
}
