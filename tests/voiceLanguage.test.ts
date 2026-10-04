import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { voiceLanguage } from "../src/lib/voiceLanguage";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Afrikaans is answered in Afrikaans, voiced with the one model that speaks it", () => {
  for (const raw of ["afr", "af", "AFR"]) {
    assert.deepEqual(voiceLanguage(raw, 0.97), { code: "afr", name: "Afrikaans", speakable: true, ttsModel: "eleven_v3" }, raw);
  }
});

test("isiZulu, isiXhosa and the other SA languages are answered in text — no model speaks them", () => {
  assert.deepEqual(voiceLanguage("zul", 0.9), { code: "zul", name: "isiZulu", speakable: false });
  assert.deepEqual(voiceLanguage("xh", 0.9), { code: "xho", name: "isiXhosa", speakable: false });
  assert.equal(voiceLanguage("sot")?.speakable, false);
});

test("English, other languages, nothing, or a shaky guess change nothing", () => {
  for (const [raw, p] of [["eng", 0.99], ["en", 1], ["por", 0.95], [null, null], ["", 1], ["afr", 0.4]] as const) {
    assert.equal(voiceLanguage(raw, p), null, `${raw}@${p}`);
  }
});

test("the language reaches the reply, the voice model and the handoff rule", () => {
  const route = code("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(route, /voiceLanguage\(heard\?\.languageCode, heard\?\.languageProbability\)/);
  assert.match(route, /runWhatsAppBot\(from, \{ text: transcript[^}]*\}, \{ voiceNote: true, language, entryContext \}\)/);
  assert.match(code("src/lib/flowRun.ts"), /maybeAutoReply\(digits, input\.text, \{ voiceNote: true, language: opts\.language \?\? null \}\)/);
  const bot = code("src/lib/bot.ts");
  assert.match(bot, /const voiceReply = voiceOn && \(language\?\.speakable \?\? true\);/);
  // Unspeakable language with voice ON is a normal turn, not a forced handoff.
  assert.match(bot, /const handoff = ai\.handoff \|\| \(Boolean\(opts\.voiceNote\) && !voiceOn\);/);
  assert.match(bot, /sendVoiceReply\(fromDigits, ai\.reply, language\?\.ttsModel\)/);
  // Existing callers keep the plain-text contract.
  assert.match(code("src/lib/transcribe.ts"), /export async function transcribeVoice\(\s*buffer: Buffer,\s*contentType = "audio\/ogg"\s*\): Promise<string \| null>/);
});
