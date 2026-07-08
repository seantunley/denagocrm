import { getSetting } from "./settings";
import { logError } from "./errorLog";

/**
 * Transcribes an audio clip (e.g. a WhatsApp voice note) to text using an
 * OpenAI-compatible Whisper endpoint. Optional — needs OPENAI_API_KEY set.
 * Returns null if not configured or on failure (caller degrades gracefully).
 */
export async function transcribeVoice(
  buffer: Buffer,
  contentType = "audio/ogg"
): Promise<string | null> {
  const apiKey = await getSetting("OPENAI_API_KEY");
  if (!apiKey) return null;
  try {
    const ext = contentType.includes("mp3")
      ? "mp3"
      : contentType.includes("mp4") || contentType.includes("m4a")
      ? "m4a"
      : contentType.includes("wav")
      ? "wav"
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
