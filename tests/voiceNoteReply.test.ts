import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { voiceNoteTranscript } from "../src/lib/voiceNoteReply";

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

test("the button: only under a WhatsApp voice note, and it fills the reply box — never sends", () => {
  const box = code("src/components/InboxReply.tsx");
  assert.match(box, /channel === "whatsapp" && voiceNote && conversationId/);
  const start = box.indexOf("function suggestForVoiceNote");
  const fn = box.slice(start, box.indexOf("return (", start));
  assert.match(fn, /textRef\.current\.value = result\.reply/);
  assert.doesNotMatch(fn, /requestSubmit|waAction|formRef/);
});
