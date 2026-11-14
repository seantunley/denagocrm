import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, logCallDetail, parseActionList } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE, cardEmoji } from "../src/lib/assistantWhatsAppRules";
import { familyOf } from "../src/lib/assistantOutcomeRules";
import { DEBRIEF_INSTRUCTIONS, parseDebrief } from "../src/lib/voiceDebrief";

/**
 * Sean, 2026-11-14: "Calls. Record or dictate a call, and DAX writes the summary, files it and proposes the
 * follow-up." The Log a call button (record / talk it through / type) and DAX's log_call card share one save.
 */
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LEAD = "clead00000000001";

test("log_call: a call that happened, on a deal or a customer, with its follow-up", () => {
  const [call] = parseActionList([{ type: "log_call", leadId: LEAD, summary: "Wants the XL in white", notes: "• Finance via the bank", nextStep: "Send the finance form", followUp: "2026-11-20" }]);
  assert.deepEqual(call, { type: "log_call", leadId: LEAD, activity: "call", summary: "Wants the XL in white", notes: "• Finance via the bank", nextStep: "Send the finance form", followUp: "2026-11-20" });
  assert.equal(parseActionList([{ type: "log_call", contactId: LEAD, summary: "Visit", activity: "meeting" }]).length, 1, "on a customer, as a visit");
  assert.equal(parseActionList([{ type: "log_call", leadId: LEAD }]).length, 0, "a summary is required");
  assert.equal(parseActionList([{ type: "log_call", leadId: LEAD, summary: "x", followUp: "Friday" }]).length, 0, "a follow-up is a date");
  assert.equal(parseActionList([{ type: "log_call", leadId: LEAD, summary: "x", recording: "…" }]).length, 0, "strict");
});

test("the card says everything Confirm files — and that nobody is contacted", () => {
  const detail = logCallDetail({ activity: "call", notes: "• Wants white", nextStep: "Send the form", followUpLabel: "Fri 20 Nov, 09:00" });
  assert.match(detail, /• Wants white\nNext step: Send the form\nFollow-up call booked: Fri 20 Nov, 09:00\n/);
  assert.match(detail, /completed call — the customer is not contacted/);
  assert.match(logCallDetail({ activity: "meeting", notes: "" }), /\(no notes\)\nNo follow-up booked\.\nFiled as a completed visit/);
});

test("DAX is told when to log a call — and never to double-book its follow-up", () => {
  assert.match(ACTION_INSTRUCTIONS, /- log_call: a call or visit that ALREADY HAPPENED/);
  assert.match(ACTION_INSTRUCTIONS, /never a separate follow_up for the same call/);
  assert.match(ACTION_INSTRUCTIONS, /A call still to make is a follow_up, not a log_call/);
  assert.match(ACTION_INSTRUCTIONS, /when the customer has more than one open deal, ask which/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("log_call"), "confirmable from the car, on WhatsApp");
  assert.equal(cardEmoji("log_call"), "📞");
  assert.equal(familyOf("log_call").key, "notes");
});

test("Confirm saves through the Log a call button's own action — checked again, never on the card's word", () => {
  const run = code("src/app/actions/assistant.ts");
  const body = run.slice(run.indexOf('case "log_call": {'), run.indexOf('case "note": {'));
  assert.match(body, /await logVoiceDebrief\(\{/);
  const build = code("src/lib/crmAssistant.ts");
  const card = build.slice(build.indexOf('if (p.type === "log_call") {'), build.indexOf('if (p.type === "follow_up" || p.type === "meeting") {'));
  assert.match(card, /hasPermission\(user, "activities\.manage"\)/);
  assert.match(card, /canAccessLead\(user, p\.leadId\)/);
  assert.match(card, /canAccessContact\(user, p\.contactId!\)/);
  assert.match(card, /deletedAt: null/);
});

test("a recorded call: the consent line first, up to 15 minutes, transcribed and dropped", () => {
  const button = code("src/components/VoiceDebriefButton.tsx");
  assert.match(button, /Tell the customer the call is being recorded before you start/);
  // The microphone opens only from the button under that line.
  const record = button.slice(button.indexOf('if (mode === "record") {'));
  assert.ok(record.indexOf("Tell the customer") < record.indexOf("onClick={voice.start}"));
  assert.match(button, /mode === "record" \? \{ maxSeconds: CALL_RECORDING_SECONDS, bitsPerSecond: 32_000 \}/);
  assert.match(code("src/components/useVoiceRecorder.ts"), /export const CALL_RECORDING_SECONDS = 15 \* 60;/);
  const voice = code("src/app/actions/voice.ts");
  assert.match(voice, /const MAX_CALL_AUDIO_BYTES = 15 \* 1024 \* 1024;/);
  assert.match(voice, /call \? \{ timeoutMs: 180_000 \} : \{\}/, "a long call gets time to transcribe");
  assert.match(code("next.config.ts"), /bodySizeLimit: "16mb"/, "a 15 MB call fits the server action's limit");
});

test("Log a call is on the customer page as well as the deal, for those who may log activities", () => {
  const customer = code("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(customer, /\{canBookTestDrive && <VoiceDebriefButton contactId=\{contact\.id\} openDeals=\{openDeals\} \/>\}/);
  assert.match(customer, /canBookTestDrive, canOpenJobCard\] = await Promise\.all\(\[[\s\S]*?hasPermission\(user, "activities\.manage"\),\s*hasPermission\(user, "jobcards\.manage"\)/);
  assert.match(code("src/app/(app)/leads/[id]/page.tsx"), /<VoiceDebriefButton leadId=\{lead\.id\} \/>/);
});

test("a transcript of the call itself is written up like a debrief", () => {
  assert.match(DEBRIEF_INSTRUCTIONS, /a transcript of the call itself/);
  const draft = parseDebrief('{"summary":"Marcel: XL in white","notes":["Wants finance"],"nextStep":"Call back","followUpDays":3}', "Hi Marcel…", "2026-11-14");
  assert.equal(draft?.followUpDate, "2026-11-17");
});
