import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { numberWords, parsePronunciations, randCents, speakableText } from "../src/lib/spokenText";
import { voiceReplyExtras } from "../src/lib/assistantWhatsAppRules";
import { splitReply, REPLY_MARKER } from "../src/lib/assistantReply";

// elevenlabs.ts logs through a server-only module: stubbed, as the repo's other tests do. Nothing is called.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { DEFAULT_TTS_MODEL, FALLBACK_TTS_MODEL, MAX_KEYTERMS, TTS_MODELS, isOggVoiceNote, modelTakesSpeed, sttKeyterms, ttsModelFor, ttsRequest } =
  createRequire(import.meta.url)("../src/lib/elevenlabs.ts") as typeof import("../src/lib/elevenlabs");

/**
 * DAX's voice (Sean, 2026-11-02: "the voicenotes don't flow… the text to speech sounds very mechanical"; "do all
 * the ElevenLabs fixes, then features 1-4-8"; "stop the double response to a voicenote").
 */
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("numbers and rands as a South African says them", () => {
  assert.equal(numberWords(185_000), "a hundred and eighty-five thousand");
  assert.equal(numberWords(1_005), "a thousand and five");
  assert.equal(numberWords(2_350_000), "two million three hundred and fifty thousand");
  assert.equal(numberWords(21), "twenty-one");
  assert.equal(numberWords(0), "zero");
  for (const [raw, cents] of [["R 185 000,00", 18_500_000], ["R185,000", 18_500_000], ["R1 250.50", 125_050], ["R95", 9_500]] as const) {
    assert.equal(randCents(raw), cents, raw);
  }
  assert.equal(randCents("185"), null, "not an amount without the R");
});

test("written text made fit to say: lists, symbols, dates, quote numbers — and Afrikaans stays Afrikaans", () => {
  assert.equal(speakableText("Due: Mon 2 Nov & Wed 4 Nov (approx. 5% off)."), "Due: Monday 2 November and Wednesday 4 November (about 5 percent off).");
  assert.equal(speakableText("Valid until 2026-11-30."), "Valid until 30 November 2026.");
  assert.equal(speakableText("Send quote Q-1042 today."), "Send quote ten forty-two today.", "never 'quote quote'");
  assert.equal(speakableText("Q-205 is ready."), "quote two hundred and five is ready.");
  assert.equal(speakableText("Vandag:\n- Anna\n- Ben", { afrikaans: true }), "Vandag: Anna en Ben.");
  assert.equal(speakableText("See [the quote](https://x.y) [[3]] now 🙂"), "See the quote now.");
});

test("pronunciations: the owner's list, whole words only, applied to everything spoken", () => {
  assert.deepEqual(parsePronunciations("Denago = Deh-NAH-go\n\nbroken line\nTokai=Toh-KAI\n = nothing"), [["Denago", "Deh-NAH-go"], ["Tokai", "Toh-KAI"]]);
  const say = parsePronunciations("Denago = Deh-NAH-go\nXL = extra large");
  assert.equal(speakableText("Denago's Rover XL, not DenagoX.", { pronunciations: say }), "Deh-NAH-go's Rover extra large, not DenagoX.");
});

test("the voice model: Eleven v4 by default (Sean: 'Change to ElevenLabs V4'), the owner's choice otherwise — Afrikaans always gets one that speaks it", () => {
  assert.equal(DEFAULT_TTS_MODEL, "eleven_v4");
  assert.equal(FALLBACK_TTS_MODEL, "eleven_v3");
  assert.ok(!TTS_MODELS.some((m) => m.id === "eleven_turbo_v2_5"), "the deprecated old default is not offered");
  assert.ok(!TTS_MODELS.some((m) => m.id === "eleven_v4_turbo"), "v4 Turbo runs only on the dialogue WebSocket — not offered (review of #935)");
  assert.equal(ttsModelFor(null, "en"), "eleven_v4");
  assert.equal(ttsModelFor("eleven_turbo_v2_5", "en"), "eleven_v4", "a saved deprecated model is replaced");
  assert.equal(ttsModelFor("eleven_flash_v2_5", "en"), "eleven_flash_v2_5");
  assert.equal(ttsModelFor("eleven_flash_v2_5", "af"), "eleven_v4", "Flash can't speak Afrikaans");
  assert.equal(ttsModelFor("eleven_v3", "af"), "eleven_v3");
});

test("each model is asked on ITS endpoint with only the settings it takes (review of #935)", () => {
  // v4: the Text to Dialogue API — one input with our voice; stability and similarity only (no style, no speed).
  const v4 = ttsRequest("eleven_v4", "voice123", "Hello.", "af", 1.1);
  assert.equal(v4.url, "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=opus_48000_64");
  assert.deepEqual(v4.body, { inputs: [{ text: "Hello.", voice_id: "voice123" }], model_id: "eleven_v4", language_code: "af", seed: 20261102, settings: { stability: 0.5, similarity: 0.75 } });
  // v3: Text to Speech, stability only (no Speed, Similarity or Speaker Boost on v3).
  const v3 = ttsRequest("eleven_v3", "voice123", "Hello.", "en", 1.1);
  assert.equal(v3.url, "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=opus_48000_64");
  assert.deepEqual(v3.body, { text: "Hello.", model_id: "eleven_v3", language_code: "en", seed: 20261102, voice_settings: { stability: 0.5 } });
  // The v2 models: everything, with the owner's speed — and no language on Multilingual v2, which doesn't take it.
  assert.deepEqual(ttsRequest("eleven_flash_v2_5", "v", "Hi.", "en", 1.05).body, {
    text: "Hi.", model_id: "eleven_flash_v2_5", language_code: "en", seed: 20261102,
    voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 1.05 },
  });
  assert.ok(!("language_code" in ttsRequest("eleven_multilingual_v2", "v", "Hi.", "en", 1).body));
  // Speed is offered in Settings only for a model that takes it.
  assert.deepEqual(TTS_MODELS.filter((m) => modelTakesSpeed(m.id)).map((m) => m.id), ["eleven_multilingual_v2", "eleven_flash_v2_5"]);
});

test("only an OGG/Opus file counts as a voice note — anything else, or a refused model, falls back to v3", () => {
  assert.equal(isOggVoiceNote(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02])), true);
  assert.equal(isOggVoiceNote(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00])), false, "an MP3 is not a WhatsApp voice note");
  assert.equal(isOggVoiceNote(new Uint8Array([])), false);
  const lib = code("src/lib/elevenlabs.ts");
  assert.match(lib, /return isOggVoiceNote\(buffer\) \? \{ buffer \} : \{ status: res\.status, detail: `not an OGG voice note/);
  assert.match(lib, /if \("status" in result && model !== FALLBACK_TTS_MODEL && \(result\.status === 200 \|\| \[400, 403, 404, 422\]\.includes\(result\.status\)\)\)/, "a refused KEY (401) is not retried");
  assert.match(lib, /result = await speak\(FALLBACK_TTS_MODEL\);/);
});

test("transcription: names to expect (feature 1) and no 'um's (feature 4)", () => {
  // ElevenLabs' rules: < 50 characters, at most 5 words, none of < > { } [ ] \ ; deduped; at most 100.
  assert.deepEqual(sttKeyterms(["Denago", "denago", "Rover XL", "a", null, "x".repeat(60), "one two three four five six", "Anna <b>Smith</b>"]), ["Denago", "Rover XL", "Anna b Smith /b"]);
  assert.equal(sttKeyterms(Array.from({ length: 300 }, (_, i) => `Name ${i}`)).length, MAX_KEYTERMS, "more than 100 bills every clip as 20 seconds");
  const lib = code("src/lib/elevenlabs.ts");
  assert.match(lib, /if \(model === "scribe_v2"\) form\.append\("no_verbatim", "true"\);/);
  assert.match(lib, /for \(const term of sttKeyterms\(opts\.keyterms \?\? \[\]\)\) form\.append\("keyterms", term\);/);
  // Customers' names only with the owner's switch ON (default off — POPIA); everything else always.
  const terms = code("src/lib/voiceKeyterms.ts");
  assert.match(terms, /customersOn === "on"\s*\? prisma\.lead\.findMany/);
  assert.match(code("src/lib/transcribe.ts"), /elevenLabsSTTDetailed\(buffer, contentType, \{ keyterms: await keyterms\(\) \}\)/);
});

test("DAX's reply block can carry what to SAY — used only when it still matches the answer", () => {
  const parsed = splitReply(`Two follow-ups are overdue.\n${REPLY_MARKER}\n{"spoken":"Two things are overdue — Anna and Ben."}`);
  assert.equal(parsed.spoken, "Two things are overdue — Anna and Ben.");
  assert.equal(splitReply("No block here.").spoken, null);
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /\.\.\.\(opts\.spoken && reply\.spoken && settled === null && !note \? \{ spoken: reply\.spoken \} : \{\}\)/);
  assert.match(lib, /opts\.spoken \? SPOKEN_RULE : ""/);
});

test("a voice reply is the voice note alone; only buttons follow it", () => {
  assert.deepEqual(voiceReplyExtras([]), { texts: [], buttons: null });
  assert.deepEqual(voiceReplyExtras(["Call Anna", "Email Anna"]), { texts: [], buttons: { body: "Tap one, or just ask:", titles: ["Call Anna", "Email Anna"] } });
  const many = ["One", "Two", "Three", "Four"];
  assert.deepEqual(voiceReplyExtras(many).texts, ["1. One\n2. Two\n3. Three\n4. Four"], "too many for buttons: the numbered list, so '2' works");
});

test("the customer chatbot: said, not read — and a reply too long to say whole goes as text", () => {
  const bot = code("src/lib/bot.ts");
  assert.match(bot, /const spoken = speakableText\(text, \{ afrikaans: language === "af", pronunciations: parsePronunciations\(/);
  assert.match(bot, /const audio = spoken && spoken\.length <= SPOKEN_CHARS \? await elevenLabsTTS\(spoken, \{ language \}\) : null;/);
});

test("Settings: pick a voice by ear (owner only), the model, the speed, pronunciations, and the customer-names switch", () => {
  const preview = code("src/app/actions/voicePreview.ts");
  assert.ok(preview.indexOf("withActingStaffScope(") < preview.indexOf("await requireTenantOwner()"));
  assert.ok(preview.indexOf("await requireTenantOwner()") < preview.indexOf("await elevenLabsTTS("));
  assert.match(preview, /if \(id && !\/\^\[A-Za-z0-9\]\{8,40\}\$\/\.test\(id\)\) return/);
  const rows = code("src/components/settings/WorkspaceIntegrationRows.tsx");
  assert.match(rows, /<VoicePicker voices=\{voices\} current=\{setting\("ELEVENLABS_VOICE_ID"\)\} \/>/);
  for (const key of ["TTS_MODEL_KEY", "VOICE_SPEED_KEY", "PRONUNCIATIONS_KEY", "STT_CUSTOMER_NAMES_KEY"]) assert.match(rows, new RegExp(`name="key" value=\\{${key}\\}`), key);
  // The speed control only for a model that takes it; otherwise it says why (review of #935).
  assert.match(rows, /\{modelTakesSpeed\(TTS_MODELS\.some\(\(m\) => m\.id === setting\(TTS_MODEL_KEY\)\) \? setting\(TTS_MODEL_KEY\) : DEFAULT_TTS_MODEL\) \? \(/);
  assert.match(rows, /Speaking speed isn&apos;t adjustable with Eleven v4 or v3/);
  assert.match(rows, /defaultChecked=\{setting\(STT_CUSTOMER_NAMES_KEY\) === "on"\}/, "off unless switched on");
});
