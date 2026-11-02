import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, NURTURE_RULE, parseActionList } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";

/**
 * Sean, 2026-11-02, on WhatsApp: "Full history, but it's not lost — should be in Nurture." DAX proposed a STAGE called
 * Nurture (no pipeline has one: nurture is a deal's status), the stage card dropped it without a word, and the answer —
 * the history he asked for — was replaced by "I couldn't set that up". DAX now knows what Nurture is, can park a deal
 * there through the lead page's own Reopen and Move to Nurture, and says why when a stage or person isn't found.
 */
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const LEAD = "cmlead00000000000000001";

test("the proposal: why it is parked (the form's own reasons), what they want, when to follow up, the review day", () => {
  const ok = { type: "nurture", leadId: LEAD, because: "timing", interest: "Rover XL", trigger: "When his bonus comes in March", reviewOn: "2027-03-01" };
  assert.deepEqual(parseActionList([ok]), [ok]);
  assert.deepEqual(parseActionList([{ ...ok, to: "Donovan" }]), [{ ...ok, to: "Donovan" }]);
  for (const bad of [
    { ...ok, because: "lost" },
    { ...ok, reviewOn: "March" },
    { ...ok, interest: "" },
    { ...ok, trigger: "no" },
    { ...ok, interest: "x".repeat(121) },
    { ...ok, stage: "Nurture" },
  ]) assert.deepEqual(parseActionList([bad]), [], JSON.stringify(bad));
  // The form's reasons, exactly — one list.
  const nurture = code("src/lib/leadNurture.ts");
  for (const key of ["product", "timing", "budget", "customer", "other"]) assert.match(nurture, new RegExp(`\\b${key}: "`), key);
});

test("DAX is told what Nurture IS — a status, parked not lost, never a stage — and how to ask for it", () => {
  assert.ok(ACTION_INSTRUCTIONS.includes(NURTURE_RULE));
  assert.match(NURTURE_RULE, /nurture \(PARKED for a later follow-up — NOT lost/);
  assert.match(NURTURE_RULE, /Nurture is a status, never a stage: never propose a stage called Nurture\./);
  assert.match(NURTURE_RULE, /A LOST deal can be parked: the card reopens it first, and says so\. A won deal can't\./);
  assert.match(ACTION_INSTRUCTIONS, /\{"type":"nurture","leadId":"<id>","because":"product\|timing\|budget\|customer\|other"/);
  // Its lookups see it: the deal's nurture details, and nurture as a status to list.
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /\.\.\.\(lead\.status === "nurture"\s*\? \{ nurture: \{ since: /);
  assert.match(code("src/lib/crmAssistantPlan.ts"), /status: z\.enum\(\["open", "nurture", "won", "lost", "any"\]\)\.optional\(\),/);
  assert.match(code("src/lib/assistantSoul.ts"), /park a deal in Nurture for a later follow-up \(reopening a lost one first\)/);
  // Confirmed on WhatsApp too (where he asked) — nobody is contacted.
  assert.ok(WHATSAPP_CONFIRMABLE.has("nurture"));
});

test("a stage or a person that isn't found is SAID — never dropped without a word", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const stage = lib.slice(lib.indexOf('} else if (p.type === "stage") {'), lib.indexOf('} else if (p.type === "draft_message") {'));
  assert.match(stage, /if \(!stage\) \{\s*problems\.push\(\/\^nurtur\/i\.test\(wantedStage\)/);
  assert.match(stage, /Nurture isn't a stage — it's how a deal is parked for later\./);
  assert.match(stage, /if \(stage\.id === lead\.stageId\) \{ problems\.push\(/);
  assert.doesNotMatch(stage, /\bcontinue;\s*\n\s*cards\.push/, "no silent continue before the card");
  const assign = lib.slice(lib.indexOf('} else if (p.type === "assign") {'), lib.indexOf('} else if (p.type === "stage") {'));
  assert.match(assign, /if \(!person\) \{ problems\.push\(`I can't find "\$\{p\.to\}" among the people who can take a deal\.`\); continue; \}/);
});

test("the card: offered only when it can run — the lead page's permissions, an active salesperson, a lost deal says it reopens", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const branch = lib.slice(lib.indexOf('} else if (p.type === "nurture") {'), lib.indexOf('} else if (p.type === "quote") {'));
  assert.match(branch, /if \(wasStatus !== "open" && wasStatus !== "nurture" && wasStatus !== "lost"\)/, "a won deal is never parked");
  assert.match(branch, /hasPermission\(user, "leads\.change_stage"\)\) \|\| !\(await hasPermission\(user, "activities\.manage"\)\)/);
  assert.match(branch, /if \(wasStatus === "lost" && !\(await hasPermission\(user, "leads\.reopen"\)\)\)/);
  assert.match(branch, /if \(!reviewDate\(p\.reviewOn\)\)/);
  assert.match(branch, /const ownerId = named\?\.id \?\? lead\.assignedToId \?\? user\.id;/);
  assert.match(branch, /if \(!owner\) \{ problems\.push\(/, "a salesperson no longer active is not put on the card");
  assert.match(branch, /if \(ownerId !== lead\.assignedToId && !\(await hasPermission\(user, "leads\.assign"\)\)\)/);
  assert.match(branch, /It's marked lost now\$\{lead\.lostReason \? ` \(\$\{lead\.lostReason\}\)` : ""\} — confirming reopens it first\./);
  assert.match(branch, /"Nobody is contacted\."/);
});

test("Confirm: every refusal before the reopen; done already writes nothing; reopened-not-parked is finished by a retry, never reopened twice", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "nurture": {'), action.indexOf('case "quote": {'));
  const reopen = run.indexOf("await reopenLead(card.leadId)");
  for (const before of [
    'return untouched("You can\'t open that deal any more.")',
    'return untouched("That deal is no longer there.")',
    "const input = parseNurtureForm(form);",
    "if (now.status !== card.wasStatus && !reopenedAlready) return untouched(STALE_CARD);",
    'return untouched("Your role can\'t park this deal in Nurture.")',
    'await resolveAssignableUser(input.assignedToId, "salesperson")',
  ]) assert.ok(run.indexOf(before) > -1 && run.indexOf(before) < reopen, before);
  // A second Confirm finds it parked with these details, and says so without writing.
  assert.ok(run.indexOf("return { ok: true, success: parkedOn, href: `/leads/${card.leadId}` };") < reopen);
  assert.ok(reopen < run.indexOf("await saveLeadNurture(card.leadId, form)"));
  assert.match(run, /if \(now\.status === "lost"\) \{\s*const result = await reopenLead\(card\.leadId\);/, "only a deal that IS lost is reopened");
  assert.match(run, /await confirmed\("park the deal in Nurture", card\.leadId\);/);
});
