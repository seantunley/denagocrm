import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { keepsEveryNumber, voiceLanguage } from "../src/lib/voiceLanguage";

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

test("a translated FAQ answer is used only if every figure survived", () => {
  const approved = "The Carrier 4 is R185 000 and the Carrier 6 is R215,000, with a 2-year warranty.";
  assert.equal(keepsEveryNumber(approved, "Die Carrier 4 kos R185 000 en die Carrier 6 R215 000, met 'n 2-jaar waarborg."), true);
  assert.equal(keepsEveryNumber(approved, "Die Carrier 4 kos R185 000 en die Carrier 6 R205 000, met 'n 2-jaar waarborg."), false, "a changed price");
  assert.equal(keepsEveryNumber(approved, "Die Carrier 4 kos R185 000 met 'n waarborg."), false, "a dropped price");
  assert.equal(keepsEveryNumber("Open weekdays.", "Oop op weeksdae."), true, "nothing numeric to lose");
});

test("canonical and builtin answers follow the customer's language, safely (review on #764)", () => {
  const ai = code("src/lib/botAi.ts");
  // The model sees the approved answers only when it must translate them.
  assert.match(ai, /input\.language \? `\[\$\{p\.id\}\] \$\{p\.when\}\\n  APPROVED ANSWER: /);
  assert.match(ai, /const translated = input\.language && parsed\.reply && keepsEveryNumber\(pathway\.answer, parsed\.reply\) \? parsed\.reply : null;/);
  assert.match(ai, /reply: personalize\(translated \?\? pathway\.answer, input\.customerName\),\s*localized: Boolean\(translated\),/);
  // The fixed handoff line is English, and says so.
  assert.match(ai, /they'll pick it up from here 👍",\s*localized: false,/);
});

test("the language reaches the reply, the voice model and the handoff rule", () => {
  const route = code("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(route, /voiceLanguage\(heard\?\.languageCode, heard\?\.languageProbability\)/);
  assert.match(route, /runWhatsAppBot\(from, \{ text: transcript[^}]*\}, \{ voiceNote: true, language, entryContext \}\)/);
  assert.match(code("src/lib/flowRun.ts"), /maybeAutoReply\(digits, input\.text, \{ voiceNote: true, language: opts\.language \?\? null \}\)/);
  const bot = code("src/lib/bot.ts");
  // Review on #764: the reply's ACTUAL language decides the voice.
  assert.match(bot, /const replyLanguage = language && ai\.localized \? language : null;/);
  assert.match(bot, /const voiceReply = voiceOn && \(replyLanguage\?\.speakable \?\? true\);/);
  // Unspeakable language with voice ON is a normal turn, not a forced handoff.
  assert.match(bot, /const handoff = ai\.handoff \|\| \(Boolean\(opts\.voiceNote\) && !voiceOn\);/);
  assert.match(bot, /sendVoiceReply\(fromDigits, ai\.reply, replyLanguage\?\.ttsModel\)/);
  // Existing callers keep the plain-text contract.
  assert.match(code("src/lib/transcribe.ts"), /export async function transcribeVoice\(\s*buffer: Buffer,\s*contentType = "audio\/ogg"\s*\): Promise<string \| null>/);
});
