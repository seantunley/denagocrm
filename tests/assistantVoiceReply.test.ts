import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { REST_IN_CHAT, SPOKEN_CHARS, spokenAnswer, voiceLanguageFor, voiceRepliesSwitchOn } from "../src/lib/assistantVoiceRules";
import { voiceLanguage } from "../src/lib/voiceLanguage";

/*
 * DAX reading its answer aloud: on WhatsApp (a voice note back for a voice note)
 * and with the CRM's Listen button. What's read is a short clean version of the
 * answer; the text is always still sent; and nothing reaches ElevenLabs unless
 * the owner switched it on and the person is under their hourly cap. Every
 * collaborator is faked — no ElevenLabs, no Meta, no database.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/* ── the spoken version ────────────────────────────────────────────────── */

test("spokenAnswer drops emoji, evidence markers, URLs and markdown; list items become sentences", () => {
  const answer = [
    "🔥 **Two follow-ups** are overdue [[1]]:",
    "- Anna Smith — quote viewed twice 👀 [[2]]",
    "- Ben Jacobs, see https://crm.example.com/leads/abc",
    "1. Call Cara [today](https://crm.example.com/x)",
  ].join("\n");
  const spoken = spokenAnswer(answer);
  assert.equal(spoken, "Two follow-ups are overdue: Anna Smith — quote viewed twice. Ben Jacobs, see. Call Cara today");
  assert.doesNotMatch(spoken, /\[\[|https?:|\*|🔥|👀/u);
  assert.ok(spoken.length <= answer.length);
});

test("a short plain answer is unchanged", () => {
  for (const answer of ["You have no overdue follow-ups.", "Anna's quote is R185 000, valid until 14 October."]) {
    assert.equal(spokenAnswer(answer), answer);
  }
  assert.equal(spokenAnswer("✅"), "", "nothing left to say → nothing to synthesise");
});

test("a long answer is cut at a sentence end, says the rest is in the chat, and is never longer than the text", () => {
  const sentence = "Anna Smith viewed her quote twice this week and has not signed it yet. ";
  const answer = sentence.repeat(20);
  const spoken = spokenAnswer(answer);
  assert.ok(spoken.length <= SPOKEN_CHARS, String(spoken.length));
  assert.ok(spoken.length < answer.length);
  assert.ok(spoken.endsWith(`yet. ${REST_IN_CHAT}`), spoken.slice(-60));
  // One enormous sentence: cut at a word instead, still within the cap.
  const runOn = "and then ".repeat(200);
  const cut = spokenAnswer(runOn);
  assert.ok(cut.length <= SPOKEN_CHARS);
  assert.ok(cut.endsWith(`… ${REST_IN_CHAT}`));
  // Over the cap only because of markers: the cap is on what's SPOKEN, so it's read whole.
  const marked = "Short line [[1]]. ".repeat(35).trim();
  assert.ok(marked.length > SPOKEN_CHARS);
  assert.ok(!spokenAnswer(marked).endsWith(REST_IN_CHAT));
  // Numbers at the start of a line are words, not bullets.
  assert.equal(spokenAnswer("3.5% above prime\n-5% on the demo unit"), "3.5% above prime. -5% on the demo unit");
});

test("the voice follows the ANSWER's language; languages no model speaks get text only", () => {
  const afrikaans = "Jy het twee opvolge wat vandag agterstallig is.";
  const english = "You have two follow-ups that are overdue today.";
  const v3 = voiceLanguage("afr")!.ttsModel;
  assert.equal(v3, "eleven_v3");
  assert.deepEqual(voiceLanguageFor(english), {});
  assert.deepEqual(voiceLanguageFor(afrikaans), { ttsModel: v3 });
  assert.deepEqual(voiceLanguageFor(afrikaans, voiceLanguage("af", 0.9)), { ttsModel: v3 });
  // Asked in Afrikaans, answered in English → the English voice.
  assert.deepEqual(voiceLanguageFor(english, voiceLanguage("afr", 0.9)), {});
  // A short Afrikaans answer: the heard language tips it.
  assert.deepEqual(voiceLanguageFor("Ja, twee.", voiceLanguage("afr", 0.9)), { ttsModel: v3 });
  // An English answer that names "Die Hoek" is still English.
  assert.deepEqual(voiceLanguageFor("The quote for Die Hoek Estate is waiting for a signature."), {});
  for (const code of ["zul", "xho", "sot"]) assert.equal(voiceLanguageFor("Sawubona", voiceLanguage(code, 0.9)), null, code);
});

test("the owner's switch is off unless exactly on", () => {
  for (const raw of [null, undefined, "", "off", "true", "ON"]) assert.equal(voiceRepliesSwitchOn(raw), false, String(raw));
  assert.equal(voiceRepliesSwitchOn("on"), true);
});

/* ── WhatsApp, behaviourally ───────────────────────────────────────────── */

const ANSWER = "Two follow-ups are overdue.";
const state = {
  switches: new Map<string, string>(),
  canSynth: true,
  sent: [] as { kind: "text" | "audio" | "buttons"; to: string; body: string }[],
  transcribed: [] as ("plain" | "detailed")[],
  languageCode: null as string | null,
  synthesised: [] as string[],
  synthResult: "ok" as "ok" | "failed",
  uploadFails: false,
  voiceReplyCounts: 0,
  voiceReplyCap: 30,
  errors: [] as string[],
};

const link = { id: "l1", tenantId: "t1", userId: "u1", waId: "27821234567", codeHash: null, codeExpiresAt: null, verifiedAt: new Date(), sessionVersion: 1 };
const fakeDb = {
  assistantPhoneLink: {
    findFirst: async ({ where }: { where: { waId?: string } }) => (where.waId === link.waId ? link : null),
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
  },
  $transaction: async () => false,
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const fromLib = (parent: { filename?: string } | undefined) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/assistantWhatsApp.ts");

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (fromLib(parent)) {
    switch (request) {
      case "./db": return { basePrisma: fakeDb };
      case "./settings": return { getSetting: async (key: string) => state.switches.get(key) ?? null };
      case "./tenantScope": return { currentTenantScope: () => ({ tenantId: "t1", system: false }) };
      case "./whatsapp": return {
        waDigits: (p: string) => p.replace(/\D/g, ""),
        matchByPhone: async () => ({ contactId: null, leadId: null, ambiguous: false }),
        fetchWhatsAppMedia: async () => ({ buffer: Buffer.from("x"), contentType: "audio/ogg" }),
        sendWhatsAppText: async (to: string, body: string) => { state.sent.push({ kind: "text", to, body }); return { ok: true }; },
        sendWhatsAppButtons: async (to: string, body: string) => { state.sent.push({ kind: "buttons", to, body }); return { ok: true }; },
        uploadWhatsAppMedia: async (_b: Buffer, contentType: string, filename: string) =>
          state.uploadFails ? { error: "nope" } : { id: `media:${contentType}:${filename}` },
        sendWhatsAppAudioId: async (to: string, id: string) => { state.sent.push({ kind: "audio", to, body: id }); return { ok: true }; },
      };
      case "./transcribe": return {
        transcribeVoice: async () => { state.transcribed.push("plain"); return "what is overdue today"; },
        transcribeVoiceDetailed: async () => {
          state.transcribed.push("detailed");
          return { text: "what is overdue today", languageCode: state.languageCode, languageProbability: 0.95 };
        },
      };
      case "./crmAssistant": return {
        askCrm: async () => ({ ok: true, answer: ANSWER, rows: [], tools: [], learned: 0, actions: [], choices: [] }),
      };
      case "./assistantUser": return {
        assistantUserFor: async (id: string) => ({ id, name: id, email: `${id}@x`, role: "staff" }),
        assistantAskAllowed: async () => true,
        assistantVoiceReplyAllowed: async () => ++state.voiceReplyCounts <= state.voiceReplyCap,
        ASK_LIMIT_MESSAGE: "limit",
      };
      case "./userSecurity": return { readUserSecurityStateStrict: async () => ({ sessionVersion: 1, disabledAt: null }) };
      case "./audit": return { logAudit: async () => {} };
      case "./errorLog": return { logError: async (...args: unknown[]) => { state.errors.push(args.map(String).join(" ")); } };
      case "./rateLimit": return { rateLimitKey: (a: string, b: string) => `${a}:${b}`, registerRateLimitAttempt: async () => ({ allowed: true }) };
      case "./elevenlabs": return { canSynthesizeVoice: async () => state.canSynth };
      case "./assistantVoice": return {
        synthesiseAnswer: async (answer: string) => {
          state.synthesised.push(answer);
          return state.synthResult === "ok" ? { buffer: Buffer.from("OggS"), contentType: "audio/ogg" } : "failed";
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { handleStaffWhatsApp } = require_("../src/lib/assistantWhatsApp.ts") as typeof import("../src/lib/assistantWhatsApp");

const STAFF = link.waId;
const kinds = () => state.sent.map((s) => s.kind);

beforeEach(() => {
  state.switches = new Map([["ASSISTANT_WHATSAPP", "on"], ["ASSISTANT_VOICE_REPLIES", "on"]]);
  state.canSynth = true;
  state.sent = [];
  state.transcribed = [];
  state.languageCode = null;
  state.synthesised = [];
  state.synthResult = "ok";
  state.uploadFails = false;
  state.voiceReplyCounts = 0;
  state.voiceReplyCap = 30;
  state.errors = [];
});

test("a voice note, switch on → the full text FIRST, then a voice note of the answer", async () => {
  assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" }), true);
  assert.deepEqual(kinds(), ["text", "audio"]);
  assert.equal(state.sent[0].body, ANSWER, "the text is the record — always sent in full");
  assert.equal(state.sent[1].body, "media:audio/ogg:voice-reply.ogg", "uploaded as an .ogg voice note, sent by media id");
  assert.deepEqual(state.synthesised, [ANSWER]);
  assert.deepEqual(state.transcribed, ["detailed"], "the language heard decides the voice");
});

test("a TYPED question gets text only, even with the switch on", async () => {
  await handleStaffWhatsApp(STAFF, { text: "what's overdue?" });
  assert.deepEqual(kinds(), ["text"]);
  assert.equal(state.synthesised.length, 0);
  assert.equal(state.voiceReplyCounts, 0);
});

test("switch off (or unset) → a voice note gets text only, and nothing is synthesised", async () => {
  for (const off of [null, "off"]) {
    state.sent = [];
    if (off === null) state.switches.delete("ASSISTANT_VOICE_REPLIES");
    else state.switches.set("ASSISTANT_VOICE_REPLIES", off);
    await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" });
    assert.deepEqual(kinds(), ["text"], String(off));
  }
  assert.equal(state.synthesised.length, 0);
  assert.equal(state.voiceReplyCounts, 0);
});

test("no voice set up → text only, and the cap isn't used", async () => {
  state.canSynth = false;
  await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" });
  assert.deepEqual(kinds(), ["text"]);
  assert.equal(state.voiceReplyCounts, 0);
});

test("over the hourly voice cap → text only", async () => {
  state.voiceReplyCap = 1;
  await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" });
  await handleStaffWhatsApp(STAFF, { voiceMediaId: "m2" });
  assert.deepEqual(kinds(), ["text", "audio", "text"]);
  assert.equal(state.synthesised.length, 1, "nothing sent to ElevenLabs over the cap");
});

test("a language no model speaks → text only, cap untouched", async () => {
  state.languageCode = "zul";
  await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" });
  assert.deepEqual(kinds(), ["text"]);
  assert.equal(state.voiceReplyCounts, 0);
  assert.equal(state.synthesised.length, 0);
});

test("ElevenLabs or Meta failing → the text still went, quietly, with a reason-only log", async () => {
  state.synthResult = "failed";
  assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" }), true);
  assert.deepEqual(kinds(), ["text"]);
  state.sent = [];
  state.synthResult = "ok";
  state.uploadFails = true;
  assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m2" }), true);
  assert.deepEqual(kinds(), ["text"]);
  assert.ok(state.errors.some((e) => /voice reply upload failed/.test(e)));
  for (const e of state.errors) assert.ok(!e.includes("overdue"), "no answer text in the log");
});

/* ── wiring, by source ─────────────────────────────────────────────────── */

test("speakAssistantAnswer: permission, module, switch, the CALLER's own turn and the cap — all before synthesising", () => {
  const src = code("src/app/actions/assistantVoice.ts");
  const at = (s: string) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  const synth = at("synthesiseAnswer(turn.answer)");
  assert.ok(at("withActingStaffScope(") < at("requireAnyPermission(...ASSISTANT_PERMISSIONS)"));
  for (const check of [
    "requireAnyPermission(...ASSISTANT_PERMISSIONS)",
    'isModuleEnabled("automation")',
    "assistantVoiceRepliesOn()",
    "where: { id: String(turnId), userId: user.id }",
    "assistantVoiceReplyAllowed(user.id)",
  ]) assert.ok(at(check) < synth, check);
  // Read-only, never stored.
  assert.doesNotMatch(src, /assistantTurn\.(update|create|upsert)|putSetting|saveFile|put\(/);
});

test("the WhatsApp voice reply is gated on a voice note AND the switch AND the cap, and the text goes first", () => {
  const src = code("src/lib/assistantWhatsApp.ts");
  assert.match(src, /const voiceBack = "voiceMediaId" in input && voiceRepliesSwitchOn\(await getSetting\(ASSISTANT_VOICE_REPLIES_KEY\)\);/);
  assert.match(src, /await sendPlan\(waId, plan\);\n\s*if \(voiceBack && answer\) await sendVoiceAnswer\(user\.id, waId, answer, heard\);/);
  const voice = src.slice(src.indexOf("async function sendVoiceAnswer"));
  assert.ok(voice.indexOf("assistantVoiceReplyAllowed(userId)") < voice.indexOf("synthesiseAnswer("));
  // The customer bot's sender, not a second one.
  assert.match(voice, /uploadWhatsAppMedia\(audio\.buffer, audio\.contentType, "voice-reply\.ogg"\)/);
  assert.match(voice, /sendWhatsAppAudioId\(waId, uploaded\.id\)/);
});

test("the owner's switch: owner only, audited, default off — and DAX knows about it", async () => {
  const save = code("src/app/actions/assistantSettings.ts");
  const card = save.slice(save.indexOf("export async function saveAssistantWhatsAppCard"));
  assert.match(card, /await saveAssistantWhatsApp\(formData\)/, "the WhatsApp switch is still saved by its own action");
  assert.match(card, /const user = await requireTenantOwner\(\);/);
  assert.match(card, /logAudit\(/);
  const page = code("src/app/(app)/settings/assistant/page.tsx");
  assert.match(page, /<SaveForm action=\{saveAssistantWhatsAppCard\}/);
  assert.match(page, /name="voiceReplies"/);
  const { selfKnowledge } = await import("../src/lib/assistantSoul");
  assert.match(selfKnowledge("DAX"), /voice note to you on WhatsApp gets a short spoken answer back as well as the full text/);
  assert.match(selfKnowledge("DAX"), /Listen button/);
});
