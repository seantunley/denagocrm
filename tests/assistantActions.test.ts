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

test("a note can go on a CUSTOMER with no lead, and be pinned — proposed, checked, and saved by the note box's own action", () => {
  const CONTACT = "cmzyxwvutsrqponmlkjihgfe";
  // Parsed: pin is optional and a boolean; a customer note names a contact, never a lead.
  const { actions } = splitActions(
    `Set up for you to confirm.\nACTIONS: [{"type":"customer_note","contactId":"${CONTACT}","text":"Testing","pin":true},{"type":"note","leadId":"${LEAD}","text":"Call back","pin":true},{"type":"note","leadId":"${LEAD}","text":"Plain"},{"type":"customer_note","leadId":"${LEAD}","text":"wrong id field"},{"type":"customer_note","contactId":"${CONTACT}","text":"x","pin":"yes"}]`,
  );
  assert.deepEqual(actions, [
    { type: "customer_note", contactId: CONTACT, text: "Testing", pin: true },
    { type: "note", leadId: LEAD, text: "Call back", pin: true },
    { type: "note", leadId: LEAD, text: "Plain" },
  ]);

  // Resolved: only a customer this person can open, not one in the bin; nothing is run.
  const lib = code("src/lib/crmAssistant.ts");
  const resolve = lib.slice(lib.indexOf("async function resolveActions"), lib.indexOf("function dedupeRows"));
  const branch = resolve.slice(resolve.indexOf('if (p.type === "customer_note")'), resolve.indexOf("if (!(await canAccessLead(user, p.leadId))) continue;"));
  assert.match(branch, /if \(!\(await canAccessContact\(user, p\.contactId\)\)\) continue;/);
  assert.match(branch, /where: \{ id: p\.contactId, deletedAt: null \}/);
  assert.match(branch, /kind: "customer_note", contactId: p\.contactId, leadId: null/);
  assert.match(branch, /continue;\s*\}\s*$/, "a customer note never falls through to the lead checks");

  // When no lead matches a name, matching customers are reported — with ids, without contact details.
  const find = lib.slice(lib.indexOf("export async function customersNamed"), lib.indexOf("export async function leadBrief"));
  assert.match(find, /const ids = await getAccessibleContactIds\(user\);\s*if \(ids !== null && ids\.length === 0\) return \[\];/);
  assert.match(find, /deletedAt: null,\s*\.\.\.\(ids === null \? \{\} : \{ id: \{ in: ids \} \}\)/);
  assert.match(find, /AND: words\.map\(/, "every word of the name must match: first and last name are separate columns");
  assert.doesNotMatch(find, /phone|email|whatsapp/i, "nothing that identifies beyond a name goes to the model");
  // Customers are looked up whether or not a lead matches, and BEFORE lead access is demanded — someone who
  // may open customers but not leads is not refused. (Who is found for whom is proved on a real database:
  // scripts/test-assistant-customers.ts.)
  const brief = lib.slice(lib.indexOf("export async function leadBrief"), lib.indexOf("async function quotesForLead"));
  assert.match(brief, /if \(!\(await hasAnyPermission\(user, "leads\.view_all", "leads\.view_owned"\)\)\) \{\s*const customers = await customersFor\(\);\s*return customers\.length \? customersOnly\(customers, "You can't see leads here\."\) : refused\("leads"\);/);
  assert.match(brief, /const customerRecords = await customersFor\(lead\.contactId\);/, "a lead that matches still brings its customer");
  assert.match(brief, /if \(matches\.length === 0\) \{[\s\S]*?const customers = await customersFor\(\);/);

  // Confirmed: through addCommunication (its own permission and customer-access checks), pinned by ITS switch.
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "customer_note"'), action.indexOf('case "assign"'));
  assert.match(run, /form\.set\("contactId", card\.contactId\);/);
  assert.doesNotMatch(run, /form\.set\("leadId"/);
  assert.match(run, /if \(card\.pin === true\) form\.set\("pin", "on"\);/);
  assert.match(run, /const result = await addCommunication\(form\);\s*if \(result\?\.error\) return \{ ok: false, error: result\.error \};/);
  assert.match(run, /contactId: card\.contactId,\s*\}\);/, "the confirmation is audited on the customer");
  const save = code("src/app/actions/communications.ts");
  assert.match(save, /if \(contactId && !\(await canAccessContact\(user, contactId\)\)\)\s*refuse\(/);
  assert.match(save, /if \(formData\.get\("pin"\) === "on"\) \{\s*await toggleTimelinePin\("communication", communication\.id, user\.id\);/);

  // The card says what it will do and links to the customer.
  const card = code("src/components/AssistantActionCard.tsx");
  assert.match(card, /card\.kind === "customer_note" \? `\/contacts\/\$\{card\.contactId\}`/);
  assert.match(card, /\(card\.kind === "note" \|\| card\.kind === "customer_note"\)/);
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
