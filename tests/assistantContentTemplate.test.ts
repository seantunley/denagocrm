import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTENT_TEMPLATE_CHARS,
  CONTENT_TEMPLATE_MORE,
  isReminder,
  reminderWords,
  templateParam,
  updateText,
} from "../src/lib/assistantWhatsAppRules";

// Sean, 2026-10-20: Donovan's reminder ran on time and sat, unread, behind "your update is ready — tap to read it".
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("an update as a template's {{1}}: one paragraph — Meta refuses line breaks, tabs and runs of spaces", () => {
  const flat = templateParam("⏰ Reminder: Call Anna\n\n📞 Call her today.\n\tMy read:    ask about the Rover.");
  assert.equal(flat, "⏰ Reminder: Call Anna · 📞 Call her today. · My read: ask about the Rover.");
  assert.doesNotMatch(flat, /[\n\t]| {5,}/);
});

test("too long for a template: cut on a word, and it says the rest is on the Ask page", () => {
  const long = templateParam(`Brief ${"word ".repeat(400)}`);
  assert.ok(long.length <= CONTENT_TEMPLATE_CHARS, String(long.length));
  assert.ok(long.endsWith(CONTENT_TEMPLATE_MORE));
  assert.doesNotMatch(long, /wor… |wo…/, "not mid-word");
  assert.equal(templateParam("short"), "short");
});

test("each kind of update has its own heading — no more '⏰ Scheduled: Customer activity'", () => {
  assert.equal(updateText({ source: "proactive", question: "Customer activity", answer: "👀 Anna just opened Q-1032.\nhttps://x" }), "👀 Anna just opened Q-1032.\nhttps://x");
  assert.match(updateText({ source: "brief", question: "Your morning brief", answer: "Your day…" }), /^☀️ Your morning brief\n\nYour day…$/);
  assert.match(updateText({ source: "followup", question: "Has Anna signed?", answer: "Not yet." }), /^🔁 Checking back: Has Anna signed\?/);
  assert.match(updateText({ source: "schedule", question: "Remind me to contact Aquila about the Rover", answer: "📞 …" }), /^⏰ Reminder: Contact Aquila about the Rover\n\n/);
  assert.match(updateText({ source: "schedule", question: "Pipeline summary", answer: "…" }), /^⏰ Scheduled: Pipeline summary/);
  assert.match(updateText({ source: "watch", question: "Q-1032", answer: "…" }), /^👀 You asked me to watch: Q-1032/);
});

test("a reminder is 'Remind me …', in the person's own words", () => {
  for (const q of ["Remind me to call Anna", "remind me about the deposit", "Please remind me that Thabo collects Friday"]) assert.ok(isReminder(q), q);
  for (const q of ["What did Anna say?", "Pipeline summary", "Who reminded Anna?"]) assert.ok(!isReminder(q), q);
  assert.equal(reminderWords("Remind me to call Anna"), "Call Anna");
  assert.equal(reminderWords("remind me about the deposit"), "The deposit");
  assert.equal(reminderWords("Remind me"), "Remind me");
});

test("the owner sets it on Settings → Assistant, validated and audited like the nudge template", () => {
  const page = read("src/app/(app)/settings/assistant/page.tsx");
  assert.match(page, /<input name="contentTemplate" defaultValue=\{contentTemplate\?\.name \?\? ""\}/);
  assert.match(page, /getSetting\(ASSISTANT_WHATSAPP_CONTENT_TEMPLATE_KEY\)\.then\(parseUpdateTemplate\)/);
  const actions = read("src/app/actions/assistantSettings.ts");
  assert.match(actions, /if \(contentName && !contentTemplate\) \{\s*refuse\(/);
  assert.match(actions, /putSetting\(ASSISTANT_WHATSAPP_CONTENT_TEMPLATE_KEY, storedContent\);\s*await logAudit\(\{\s*action: contentTemplate \? "assistant\.whatsapp_content_template_set" : "assistant\.whatsapp_content_template_cleared"/);
});

test("a reminder's phone notification says it is a reminder — and still names nothing", () => {
  const run = read("src/lib/assistantScheduleRun.ts");
  assert.match(run, /const reminder = isReminder\(schedule\.question\);\s*await sendPushToAll\(/);
  assert.match(run, /: reminder \? "⏰ You have a reminder — tap to read it\."/);
});

test("the migration is additive", () => {
  const sql = read("prisma/migrations/20261020090000_assistant_content_template/migration.sql");
  assert.match(sql, /ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "contentTemplateRefusedAt" TIMESTAMP\(3\);/);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE /);
});
