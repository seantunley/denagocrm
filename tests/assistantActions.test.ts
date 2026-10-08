import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MAX_ACTIONS, MAX_CHOICES, splitActions, splitChoices } from "../src/lib/assistantActions";
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

test("choices become buttons: parsed, stripped, capped — and all three trailers come off together", () => {
  const reply = [
    "There are two Jacobs — which one? 🤔",
    'LEARN: {"memory":[{"add":"Fleet deals go to Donovan."}]}',
    `ACTIONS: [{"type":"note","leadId":"${LEAD}","text":"Asked about finance."}]`,
    'CHOICES: ["Anna Jacobs","Ben Jacobs","Anna Jacobs","   "]',
  ].join("\n");
  const learnSplit = splitLearn(reply);
  const choiceSplit = splitChoices(learnSplit.answer);
  const { answer, actions } = splitActions(choiceSplit.answer);
  assert.equal(answer, "There are two Jacobs — which one? 🤔");
  assert.deepEqual(choiceSplit.choices, ["Anna Jacobs", "Ben Jacobs"], "deduped, blanks dropped");
  assert.equal(actions.length, 1);
  assert.equal(learnSplit.learn?.memory?.length, 1);
  // Bad lines are removed from the answer and yield no buttons.
  for (const bad of ['CHOICES: {"a":1}', "CHOICES: [broken", 'CHOICES: ["only one"]', `CHOICES: ["${"x".repeat(61)}","ok"]`]) {
    assert.deepEqual(splitChoices(`Pick one.\n${bad}`), { answer: "Pick one.", choices: [] }, bad);
  }
  assert.equal(splitChoices(`Pick.\nCHOICES: ${JSON.stringify(["a", "b", "c", "d", "e", "f"])}`).choices.length, MAX_CHOICES);
  assert.deepEqual(splitChoices("No choice here."), { answer: "No choice here.", choices: [] });
  // Wired: the answer step is told about them, the chat sends a tap as the next question.
  assert.match(code("src/lib/crmAssistant.ts"), /source === "chat" \? ACTION_INSTRUCTIONS : "",\s*source === "schedule" \? "" : CHOICE_INSTRUCTIONS,/);
  const chat = code("src/components/AssistantChat.tsx");
  assert.match(chat, /turn === turns\[0\] && !pending && turn\.choices/, "only the newest answer's choices");
  assert.match(chat, /onClick=\{\(\) => ask\(choice\)\}/);
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

test("Confirm runs the action a person would use by hand — and Confirm never sends", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf("export async function runAssistantAction"), action.indexOf("export async function sendAssistantDraft"));
  assert.match(run, /await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
  for (const delegate of [
    "scheduleFollowUp(", "addCommunication(", "assignLead(", "moveLead(", "scheduleActivity(", "createTestDriveBooking(",
    "rescheduleActivity(", "cancelActivity(", "markLost(", "createQuoteFromLead(",
  ]) {
    assert.ok(run.includes(delegate), delegate);
  }
  // Confirm on any card sends nothing to a customer.
  assert.doesNotMatch(run, /sendWhatsApp|sendEmail|sendMessenger|sendTelegram|dispatch/i);
  // The model's own path — research, answer, proposals — has no way to send at all.
  for (const file of ["src/lib/crmAssistant.ts", "src/lib/assistantActions.ts", "src/lib/assistantReply.ts"]) {
    assert.doesNotMatch(code(file), /sendWhatsApp|sendEmail|sendMessenger|sendTelegram|sendAssistantDraft|dispatch/i, file);
  }
});

test("a drafted message reaches a customer only from its card's Send button, to the lead's own address", () => {
  const action = code("src/app/actions/assistant.ts");
  const send = action.slice(action.indexOf("export async function sendAssistantDraft"), action.indexOf("const escapeHtml"));
  assert.match(send, /await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
  assert.match(send, /if \(!\(await canAccessLead\(user, String\(input\.leadId\)\)\)\)/);
  // The recipient is read here from the lead, never taken from the browser.
  assert.doesNotMatch(send, /input\.(to|phone|email)\b/);
  assert.match(send, /const phone = lead\.phone \|\| lead\.contact\?\.phone;/);
  assert.match(send, /const to = lead\.email \|\| lead\.contact\?\.email;/);
  // Through the lead page's own senders (their permission, outbox and timeline).
  assert.match(send, /await sendWhatsAppMessage\(undefined, form\)/);
  assert.match(send, /await sendEmailAction\(undefined, form\)/);
  // Its only caller: the Send button on the card.
  const card = code("src/components/AssistantActionCard.tsx");
  assert.equal(card.match(/sendAssistantDraft\(/g)?.length, 1);
  assert.match(card, /onClick=\{send\}/);
  for (const file of ["src/components/AssistantChat.tsx", "src/components/AssistantBubble.tsx", "src/app/api/assistant/ask/route.ts", "src/lib/assistantAsk.ts"]) {
    assert.doesNotMatch(code(file), /sendAssistantDraft/, file);
  }
});
