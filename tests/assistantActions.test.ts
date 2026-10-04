import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MAX_ACTIONS, splitActions } from "../src/lib/assistantActions";
import { splitLearn } from "../src/lib/assistantMemory";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const LEAD = "cmabcdefghijklmnopqrstuv";

test("proposals come out of the reply; the person never sees the ACTIONS line", () => {
  const { answer, actions } = splitActions(
    `I've set up a call with Anna for you to confirm.\nACTIONS: [{"type":"follow_up","leadId":"${LEAD}","when":"2026-10-09T10:00","activity":"call","summary":"Call Anna about the quote"},{"type":"assign","leadId":"${LEAD}","to":"Donovan"}]`,
  );
  assert.equal(answer, "I've set up a call with Anna for you to confirm.");
  assert.deepEqual(actions.map((a) => a.type), ["follow_up", "assign"]);
});

test("one bad proposal doesn't sink the rest; invented kinds and extra fields are refused", () => {
  const { actions } = splitActions(
    `ok\nACTIONS: [{"type":"send_whatsapp","leadId":"${LEAD}","body":"hi"},{"type":"note","leadId":"${LEAD}","text":"Wants white."},{"type":"stage","leadId":"${LEAD}","stage":"Won","force":true},{"type":"follow_up","leadId":"${LEAD}","when":"next tuesday"}]`,
  );
  assert.deepEqual(actions, [{ type: "note", leadId: LEAD, text: "Wants white." }]);
  const many = Array.from({ length: 9 }, () => ({ type: "note", leadId: LEAD, text: "x" }));
  assert.equal(splitActions(`ok\nACTIONS: ${JSON.stringify(many)}`).actions.length, MAX_ACTIONS);
  assert.deepEqual(splitActions("ok\nACTIONS: {not json").actions, []);
});

test("LEARN and ACTIONS lines can both trail an answer, in either order", () => {
  const reply = `Done.\nACTIONS: [{"type":"note","leadId":"${LEAD}","text":"Budget R180k."}]\nLEARN: {"profile":[{"add":"Likes short answers."}]}`;
  const learned = splitLearn(reply);
  const { answer, actions } = splitActions(learned.answer);
  assert.equal(answer, "Done.");
  assert.equal(actions.length, 1);
  assert.deepEqual(learned.learn?.profile, [{ add: "Likes short answers." }]);
});

test("proposals are checked against what this person may touch, names resolved, nothing run", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const resolve = lib.slice(lib.indexOf("async function resolveActions"), lib.indexOf("function dedupeRows"));
  assert.match(resolve, /if \(!\(await canAccessLead\(user, p\.leadId\)\)\) continue;/);
  assert.match(resolve, /staff\.find\(/, "a person must be in this workspace");
  assert.match(resolve, /where: \{ pipelineId: lead\.stage\.pipelineId \}/, "a stage must be in that lead's pipeline");
  assert.doesNotMatch(resolve, /scheduleFollowUp|assignLead|moveLead|addCommunication|\.create\(|\.update\(/, "resolving runs nothing");
});

test("Confirm runs the action a person would use by hand — and nothing is ever sent", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf("export async function runAssistantAction"), action.indexOf("export async function askCrmAction"));
  assert.match(run, /await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
  for (const delegate of ["scheduleFollowUp(", "addCommunication(", "assignLead(", "moveLead("]) {
    assert.ok(run.includes(delegate), delegate);
  }
  // No path in the assistant sends to a customer.
  for (const file of ["src/app/actions/assistant.ts", "src/lib/crmAssistant.ts", "src/lib/assistantActions.ts"]) {
    assert.doesNotMatch(code(file), /sendWhatsApp|sendEmail|sendMessenger|sendTelegram|dispatch/i, file);
  }
});
