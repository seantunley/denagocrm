/**
 * REAL ElevenLabs synthesis check (review of #935: "require a real English and Afrikaans synthesis test").
 *
 *   ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… npm run voice:check            (OUT_DIR optional, default ./voice-check)
 *
 * For each voice model DAX can use, in English and (where it speaks it) Afrikaans: the request DAX itself sends
 * (elevenlabs.ttsRequest — v4 on Text to Dialogue, the rest on Text to Speech), whether ElevenLabs accepted it, and
 * whether what came back is an OGG/Opus voice note WhatsApp will play. Each clip is saved to listen to.
 *
 * SAFETY: no database, no CRM settings, no customer — the key and voice come from the environment only, and the
 * only text sent is the fixed sample below. Costs a few hundred ElevenLabs characters.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Module from "node:module";

// elevenlabs.ts logs through server-only modules; nothing here touches them.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "";
  if (!apiKey || !voiceId) throw new Error("Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (the environment only — nothing is read from the CRM).");
  const { TTS_MODELS, DEFAULT_TTS_MODEL, ttsRequest, isOggVoiceNote } = await import("../src/lib/elevenlabs");
  const { speakableText } = await import("../src/lib/spokenText");
  const outDir = process.env.OUT_DIR || path.join(process.cwd(), "voice-check");
  mkdirSync(outDir, { recursive: true });
  const samples = {
    en: speakableText("Hi, it's DAX. Q-1030 for the Rover XL is ready: R 185 000,00, valid until Fri 6 Nov. Shall I send you the PDF?"),
    af: speakableText("Hallo, dis DAX. Die kwotasie vir die Rover XL is gereed. Moet ek vir jou die PDF stuur?", { afrikaans: true }),
  } as const;
  let defaultWorked = false;
  for (const model of TTS_MODELS) {
    for (const language of model.afrikaans ? (["en", "af"] as const) : (["en"] as const)) {
      const { url, body } = ttsRequest(model.id, voiceId, samples[language], language, 1);
      const started = Date.now();
      const res = await fetch(url, { method: "POST", headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/ogg" }, body: JSON.stringify(body) });
      const ms = Date.now() - started;
      if (!res.ok) {
        console.log(`  FAIL ${model.id} ${language}: HTTP ${res.status} in ${ms} ms — ${(await res.text().catch(() => "")).slice(0, 200)}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const ok = isOggVoiceNote(bytes);
      const file = path.join(outDir, `${model.id}-${language}.${ok ? "ogg" : "bin"}`);
      writeFileSync(file, bytes);
      console.log(`  ${ok ? "ok  " : "FAIL"} ${model.id} ${language}: ${res.headers.get("content-type") ?? "?"}, ${bytes.length} bytes, ${ms} ms${ok ? "" : " — not an OGG voice note"} → ${file}`);
      if (ok && model.id === DEFAULT_TTS_MODEL) defaultWorked = true;
    }
  }
  console.log(defaultWorked ? `\nThe default (${DEFAULT_TTS_MODEL}) works with this key and voice.` : `\nThe default (${DEFAULT_TTS_MODEL}) did NOT work — DAX would fall back to eleven_v3.`);
  process.exit(defaultWorked ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
