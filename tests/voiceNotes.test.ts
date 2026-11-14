import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseDebrief, plainDebrief } from "../src/lib/voiceDebrief";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SAID = "Spoke to Anna, she wants the 4-seater in white, budget around 180k. Call her Thursday.";

test("a debrief reply becomes an editable draft with a dated follow-up", () => {
  const draft = parseDebrief(
    '```json\n{"summary":"Anna keen on white 4-seater","notes":["Budget ~R180k","Wants white"],"nextStep":"Call Anna","followUpDays":3}\n```',
    SAID,
    "2026-10-04",
  );
  assert.deepEqual(draft, {
    summary: "Anna keen on white 4-seater",
    notes: "• Budget ~R180k\n• Wants white",
    nextStep: "Call Anna",
    followUpDate: "2026-10-07",
    transcript: SAID,
  });
  assert.equal(parseDebrief('{"summary":"x","notes":[],"followUpDays":null}', SAID, "2026-10-04")?.followUpDate, "");
});

test("an unusable reply is refused; without ChatGPT the transcript still makes a draft", () => {
  for (const reply of ["", "sorry", '{"notes":["no summary"]}', '{"summary":"x","followUpDays":-2}']) {
    assert.equal(parseDebrief(reply, SAID, "2026-10-04"), null, reply);
  }
  const plain = plainDebrief(SAID);
  assert.equal(plain.summary, "Spoke to Anna, she wants the 4-seater in white, budget around 180k.".slice(0, 80));
  assert.equal(plain.transcript, SAID);
  assert.equal(plain.followUpDate, "");
});

test("recordings are transcribed and dropped — never stored, never logged", () => {
  const voice = code("src/app/actions/voice.ts");
  assert.doesNotMatch(voice, /saveFile|savePublicAsset|\bput\(|prisma\./, "no storage, no database writes");
  for (const call of voice.match(/logError\([^)]*\)/g) ?? []) {
    assert.doesNotMatch(call, /heard|text|transcript|prompt/, call);
  }
  // Each draft: the permission, then access to THIS deal or customer (callTarget), before any audio or text is sent.
  assert.match(voice, /callTarget[\s\S]*\(leadId \? await canAccessLead\(user, leadId\) : await canAccessContact\(user, contactId\)\)/);
  for (const name of ["draftVoiceDebrief", "draftTypedDebrief"]) {
    const body = voice.slice(voice.indexOf(`export async function ${name}`));
    assert.match(body, /const user = await requirePermission\("activities\.manage"\);\s*if \(!\(await callTarget\(user, formData\)\)\)/, name);
  }
});

test("asking by voice is behind the assistant's module, checked before any audio is sent", () => {
  const voice = code("src/app/actions/voice.ts");
  const body = voice.slice(voice.indexOf("export async function transcribeQuestion"), voice.indexOf("export async function draftVoiceDebrief"));
  const gate = body.indexOf('isModuleEnabled("automation")');
  assert.ok(gate > 0, "transcribeQuestion must check the automation module");
  assert.ok(gate < body.indexOf("hear(formData)"), "before the recording reaches ElevenLabs");
});

test("saving a call is a completed activity on a deal or customer the user may touch", () => {
  const actions = code("src/app/actions/activities.ts");
  const body = actions.slice(actions.indexOf("export async function logVoiceDebrief"), actions.indexOf("export async function cancelActivity"));
  assert.match(body, /requirePermission\("activities\.manage"\)/);
  assert.match(body, /if \(Boolean\(data\.leadId\) === Boolean\(data\.contactId\)\) refuse\(/, "one deal or one customer, never both or neither");
  assert.match(body, /assertLinks\(user, \{ leadId: data\.leadId, contactId: data\.contactId \}\)/);
  assert.match(body, /prisma\.contact\.findFirst\(\{ where: \{ id: data\.contactId!, deletedAt: null \}/, "never a customer in the bin");
  assert.match(body, /status: "done",\s*doneAt: now/);
  assert.match(body, /logAudit\(/);
  // A logged call already happened: no schedule lock or clash check here.
  assert.doesNotMatch(body.slice(0, body.indexOf("scheduleFollowUpBody")), /lockStaffSchedules|findStaffAvailabilityConflict/);
});
