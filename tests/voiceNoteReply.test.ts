import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WROTE_SINCE, voiceNoteSuggestion, voiceNoteTranscript } from "../src/lib/voiceNoteReply";

const voice = { id: "v1", direction: "inbound", body: "🎤 Is the Rover still available?" };
const ours = { id: "o1", direction: "outbound", body: "Hi Anna, here is your quote" };
const later = { id: "t2", direction: "inbound", body: "Actually, make it a Nomad" };
const reply = { summary: "Asks if the Rover is available", reply: "Yes, it is." };

test("reviews of #953: the voice note shown, while it is the latest — checked before AND after the AI writes", async () => {
  let asked = 0;
  const ai = async () => { asked++; return reply; };
  // The latest message, unchanged throughout: the suggestion, with the conversation before it as history.
  let seen: unknown = null;
  const ok = await voiceNoteSuggestion("v1", { recent: async () => [voice, ours], ai: async (input) => { seen = input; return reply; } });
  assert.deepEqual(ok, { ok: true, ...reply });
  assert.deepEqual(seen, { transcript: "Is the Rover still available?", history: [{ from: "us", text: "Hi Anna, here is your quote" }] });
  // The customer wrote again before the button was pressed: refused, and the AI is never asked.
  assert.deepEqual(await voiceNoteSuggestion("v1", { recent: async () => [later, voice, ours], ai }), { ok: false, error: WROTE_SINCE });
  assert.equal(asked, 0);
  // The customer writes WHILE the AI is writing: the reading after it sees the new message — refused, nothing shown.
  let reads = 0;
  const during = await voiceNoteSuggestion("v1", { recent: async () => (reads++ === 0 ? [voice, ours] : [later, voice, ours]), ai });
  assert.deepEqual(during, { ok: false, error: WROTE_SINCE });
  assert.equal(asked, 1);
  assert.equal(reads, 2);
  // An AI failure is passed on as it is.
  assert.deepEqual(await voiceNoteSuggestion("v1", { recent: async () => [voice], ai: async () => ({ error: "AI unavailable" }) }), { ok: false, error: "AI unavailable" });
});

const code = (path: string) => readFileSync(path, "utf8");

test("the transcript is read from how the webhook logs a voice note — an untranscribed one has none", () => {
  assert.equal(voiceNoteTranscript("🎤 Hi, is the Rover still available?"), "Hi, is the Rover still available?");
  assert.equal(voiceNoteTranscript("🎤 (Afrikaans) Goeie môre, ek soek 'n kar"), "Goeie môre, ek soek 'n kar");
  assert.equal(voiceNoteTranscript("🎤 [Voice note]"), null);
  assert.equal(voiceNoteTranscript("Hi there"), null);
  assert.equal(voiceNoteTranscript(null), null);
});

test("the action: inbox.reply, only conversations this person may open, nothing sent or saved", () => {
  const action = code("src/app/actions/voiceNoteReply.ts");
  assert.match(action, /requirePermission\("inbox\.reply"\)/);
  assert.match(action, /accessibleInboxWhere\(user\)/);
  assert.match(action, /where: \{ AND: \[scope, \{ conversationId, type: "whatsapp" \}\] \}/);
  assert.match(action, /return voiceNoteSuggestion\(messageId, \{/);
  assert.doesNotMatch(action, /\.(create|update|upsert|delete)\w*\(|sendWhatsApp|logAudit/);
});

test("the AI call: phone numbers and emails taken out, no invented facts, nothing but the status logged", () => {
  const ai = code("src/lib/ai.ts");
  const fn = ai.slice(ai.indexOf("export async function aiVoiceNoteReply"), ai.indexOf("HubSpot-style enrichment"));
  assert.match(fn, /\[email\]/);
  assert.match(fn, /\[phone\]/);
  assert.match(fn, /Never invent facts, prices, stock, dates or commitments/);
  assert.doesNotMatch(fn, /logError\([^)]*transcript/);
});

test("the button: only under the customer's latest message when it is a voice note, bound to that message — never sends", () => {
  const box = code("src/components/InboxReply.tsx");
  assert.match(box, /channel === "whatsapp" && voiceNoteId && conversationId/);
  const start = box.indexOf("function putSuggestion");
  const fn = box.slice(start, box.indexOf("return (", start));
  assert.match(fn, /suggestVoiceNoteReply\(conversationId, voiceNoteId\)/);
  assert.doesNotMatch(fn, /requestSubmit|waAction|formRef/);
  const list = code("src/components/SocialThreadList.tsx");
  assert.match(list, /const latest = thread\.messages\.find\(\(m\) => m\.direction === "inbound"\);\r?\n  return latest && voiceNoteTranscript\(latest\.body\) \? latest\.id : null;/);
});

test("review of #953: a suggestion never goes over words already in the box — it waits for 'Replace my text with it'", () => {
  const box = code("src/components/InboxReply.tsx");
  const start = box.indexOf("function suggestForVoiceNote");
  const fn = box.slice(start, box.indexOf("return (", start));
  // Read when the answer arrives; text there → shown beside it, the box untouched.
  assert.match(fn, /if \(textRef\.current\?\.value\.trim\(\)\) setVoiceSuggestion\(result\.reply\);\r?\n\s*else putSuggestion\(result\.reply\);/);
  assert.match(box, /onClick=\{\(\) => putSuggestion\(voiceSuggestion\)\}>Replace my text with it</);
});
