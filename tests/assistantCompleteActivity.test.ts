import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTION_INSTRUCTIONS, parseActionList } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";

/*
 * Sean, 2026-11-17: "Follow up for Derek done. New status. Awaiting Ivan to revert" — DAX could not mark the planned
 * call done. And: "There must be context put in the done" — the note of what happened is required.
 */

const ACT = "cmactivityabcdefghijklmn";
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("a done needs its note — no note, no proposal", () => {
  assert.equal(parseActionList([{ type: "complete_activity", activityId: ACT, note: "Updated Derek. Awaiting Ivan to revert." }]).length, 1);
  assert.equal(parseActionList([{ type: "complete_activity", activityId: ACT }]).length, 0);
  assert.equal(parseActionList([{ type: "complete_activity", activityId: ACT, note: "   " }]).length, 0);
  assert.equal(parseActionList([{ type: "complete_activity", activityId: ACT, note: "x", status: "done", when: "2026-11-17T09:00" }]).length, 0);
});

test("DAX is told to propose it when they say it's done, with their words, and never for a later day", () => {
  assert.match(ACTION_INSTRUCTIONS, /complete_activity: when they say a PLANNED follow-up/);
  assert.match(ACTION_INSTRUCTIONS, /"note" is REQUIRED/);
  assert.match(ACTION_INSTRUCTIONS, /never invent one/);
  assert.match(ACTION_INSTRUCTIONS, /propose this rather than telling them to close it themselves/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("complete_activity"));
});

test("the card is only for a planned activity this person can see, not on a later day; Confirm is the CRM's Done button", () => {
  const core = code("src/lib/crmAssistant.ts");
  const branch = core.slice(core.indexOf('if (p.type === "reschedule" || p.type === "cancel_activity" || p.type === "complete_activity")'), core.indexOf('if (p.type === "schedule_delivery")'));
  assert.match(branch, /getAccessibleActivityIds\(user\)/);
  assert.match(branch, /status: "planned"/);
  assert.match(branch, /if \(isFutureDay\(activity\.dueDate\)\) \{ problems\.push\(futureActivityRefusal\(activity\.dueDate\)\); continue; \}/);
  assert.match(branch, /note: p\.note, text: completeActivityText\(p\.note\)/);

  const action = code("src/app/actions/assistant.ts");
  assert.match(action, /case "reschedule":\s*case "cancel_activity":\s*case "complete_activity": \{\s*if \(!\(await stillAsProposed\(card\)\)\) return untouched\(STALE_CARD\);\s*const result = await runActivityCard\(card\);/);
  assert.match(action, /case "cancel_activity":\s*case "complete_activity": \{\s*const activity = await prisma\.activity\.findUnique/);
  const run = code("src/lib/assistantActivityConfirm.ts");
  assert.match(run, /if \(!String\(card\.note \?\? ""\)\.trim\(\)\) return \{ error:/);
  assert.match(run, /form\.set\("note", card\.note\);/);
  assert.match(run, /await completeActivity\(card\.activityId, form\)/);
  assert.match(action, /done = card\.kind === "complete_activity";[\s\S]{0,120}done \? "mark an activity done"/);
});

test("the deal lookup hands DAX each planned activity's id", () => {
  const brief = code("src/lib/assistant/lookups/leadBrief.ts");
  assert.match(brief, /\.\.\.\(a\.status === "planned" \? \{ activityId: a\.id \} : \{\}\)/);
});
