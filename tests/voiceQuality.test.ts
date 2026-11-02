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
const { DEFAULT_TTS_MODEL, MAX_KEYTERMS, TTS_MODELS, sttKeyterms, ttsModelFor } = createRequire(import.meta.url)("../src/lib/elevenlabs.ts") as typeof import("../src/lib/elevenlabs");

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

test("the voice model: v4 Turbo by default, the owner's choice otherwise — and Afrikaans always gets one that speaks it", () => {
  assert.equal(DEFAULT_TTS_MODEL, "eleven_v4_turbo");
  assert.ok(!TTS_MODELS.some((m) => m.id === "eleven_turbo_v2_5"), "the deprecated old default is not offered");
  assert.equal(ttsModelFor(null, "en"), "eleven_v4_turbo");
  assert.equal(ttsModelFor("eleven_turbo_v2_5", "en"), "eleven_v4_turbo", "a saved deprecated model is replaced");
  assert.equal(ttsModelFor("eleven_flash_v2_5", "en"), "eleven_flash_v2_5");
  assert.equal(ttsModelFor("eleven_flash_v2_5", "af"), "eleven_v4_turbo", "Flash can't speak Afrikaans");
  assert.equal(ttsModelFor("eleven_v4", "af"), "eleven_v4");
});

test("the request: voice settings, the language, a fixed seed — and a fallback model when the chosen one is refused", () => {
  const lib = code("src/lib/elevenlabs.ts");
  assert.match(lib, /body: JSON\.stringify\(\{ text: clean, model_id: modelId, language_code: language, seed: VOICE_SEED, voice_settings: \{ \.\.\.VOICE_SETTINGS, speed \} \}\)/);
  assert.match(lib, /const VOICE_SETTINGS = \{ stability: 0\.45, similarity_boost: 0\.8, style: 0\.15, use_speaker_boost: true \} as const;/);
  assert.match(lib, /if \(!res\.ok && \[400, 404, 422\]\.includes\(res\.status\) && model !== FALLBACK_TTS_MODEL\[language\]\)/);
  assert.match(lib, /\?output_format=opus_48000_64/, "still WhatsApp's own voice-note format");
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
  assert.match(rows, /defaultChecked=\{setting\(STT_CUSTOMER_NAMES_KEY\) === "on"\}/, "off unless switched on");
});
