import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JOB_CARD_RULE, parseActionList } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE, splitForWhatsApp_cards } from "../src/lib/assistantWhatsAppRules";
import { PRIORITY_VALUES } from "../src/lib/workshop-constants";

/**
 * DAX proposes a workshop job card (2026-10-26). It is opened ONLY when the person presses Confirm, through the
 * job-card form's own action (openJobCard), with their jobcards.manage and their access to that vehicle — and
 * only with Automotive on. It never contacts the customer, and it is never confirmed from WhatsApp.
 */
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const VEHICLE = "cmvehicle0000000000000001";

test("the proposal: a vehicle id, the work, an optional priority and km in — nothing else", () => {
  const ok = { type: "job_card", vehicleId: VEHICLE, description: "Service — brakes squeaking", priority: "high", kmIn: 12500 };
  assert.deepEqual(parseActionList([ok]), [ok]);
  assert.equal(parseActionList([{ type: "job_card", vehicleId: VEHICLE, description: "Service" }]).length, 1, "priority and km are optional");
  for (const bad of [
    { ...ok, priority: "asap" }, // not a workshop priority
    { ...ok, kmIn: -5 },
    { ...ok, kmIn: 12.5 },
    { ...ok, description: "  " },
    { ...ok, vehicleId: "x" },
    { type: "job_card", description: "Service" }, // no vehicle: it is never guessed
    { ...ok, contactId: VEHICLE }, // strict: no customer, technician or bay smuggled in
    { ...ok, technicianId: VEHICLE },
  ]) {
    assert.deepEqual(parseActionList([bad]), [], JSON.stringify(bad));
  }
  // The priorities it may propose are exactly the workshop's.
  assert.deepEqual([...PRIORITY_VALUES].sort(), ["high", "low", "normal", "urgent"]);
});

test("the rule: the vehicle from the lookup, ASK WHICH when there are several, and the customer is never contacted", () => {
  assert.match(JOB_CARD_RULE, /vehicleId is the vehicleId of the customer's vehicle from the vehicles lookup \(kind customer\) — never invent one/);
  assert.match(JOB_CARD_RULE, /MORE THAN ONE VEHICLE[\s\S]*ASK WHICH[\s\S]*CHOICES[\s\S]*propose nothing until they say; never guess/);
  assert.match(JOB_CARD_RULE, /the customer is not contacted/);
  // The vehicles lookup hands the model the id it needs.
  assert.match(code("src/lib/crmAssistant.ts"), /vehicle: v\.model, vehicleId: v\.id, link: `\/vehicles\/\$\{v\.id\}`/);
  // Only a workspace with Automotive is told it can open one, and only when tasks may be proposed.
  assert.match(code("src/lib/crmAssistant.ts"), /const jobCards = proposes && modules\.has\("automotive"\) \? JOB_CARD_RULE : "";/);
  assert.match(code("src/lib/crmAssistant.ts"), /CHOICE_INSTRUCTIONS,\s*jobCards,\s*channelRule\(/);
  assert.match(code("src/lib/crmAssistantPlan.ts"), /Opening a workshop job card on a customer's vehicle: look up their vehicles \(vehicles kind customer/);
});

test("a card only with Automotive on, for someone who may manage job cards, on a vehicle they can open", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const resolve = lib.slice(lib.indexOf("async function resolveActions"), lib.indexOf("function dedupeRows"));
  const branch = resolve.slice(resolve.indexOf('if (p.type === "job_card")'), resolve.indexOf('if (p.type === "customer_note")'));
  const moduleCheck = branch.indexOf('isModuleEnabled("automotive")');
  const permission = branch.indexOf('hasPermission(user, "jobcards.manage")');
  const access = branch.indexOf("canAccessVehicle(user, p.vehicleId)");
  const read = branch.indexOf("prisma.vehicle.findFirst");
  assert.ok(moduleCheck > 0 && moduleCheck < permission && permission < access && access < read, "module, then permission, then access (tenant included) — before the vehicle is read");
  // Every refusal says why (the answer may already have said it was set up).
  assert.equal((branch.match(/problems\.push\(/g) ?? []).length, 3);
  assert.match(branch, /where: \{ id: p\.vehicleId, deletedAt: null \}/);
  // The owner the card shows is the vehicle's own, read here — never from the proposal.
  assert.match(branch, /contactId: vehicle\.contactId/);
  assert.match(branch, /kind: "job_card", leadId: null/);
});

test("Confirm opens it through the job-card form's own door, after yes/no checks, and sends nothing", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "job_card"'), action.indexOf('case "block_time"'));
  // Yes/no first: openJobCard's guard REDIRECTS, which a saved card has nowhere to follow.
  assert.match(run, /if \(!\(await isModuleEnabled\("automotive"\)\)\) return untouched\(/);
  assert.match(run, /if \(!\(await hasPermission\(user, "jobcards\.manage"\)\) \|\| !\(await canAccessVehicle\(user, vehicleId\)\)\) return untouched\(/);
  // A vehicle that changed hands since the card was shown is not what was confirmed.
  assert.match(run, /if \(vehicle\.contactId !== card\.contactId\) return untouched\(STALE_CARD\);/);
  assert.ok(run.indexOf("untouched(STALE_CARD)") < run.indexOf("await openJobCard("), "every refusal comes before anything is written");
  // ONE CONFIRM, ONE JOB CARD (review of #911): the card's key goes to the door, and a repeat gets the same card back.
  assert.match(run, /case "job_card": \{\s*if \(!CONFIRM_KEY\.test\(String\(card\.confirmKey \?\? ""\)\)\) return untouched\(STALE_CARD\);/);
  assert.match(run, /const opened = await openJobCard\(\{ vehicleId, description, kmIn, priority: card\.priority, confirmKey: card\.confirmKey \}\);\s*if \("repeated" in opened\) return \{ ok: true, success: `Already opened as job card #\$\{opened\.number\} — nothing was opened twice\.`, href: `\/jobcards\/\$\{opened\.id\}` \};/);
  assert.match(code("src/lib/crmAssistant.ts"), /"Opened in the workshop only — the customer is not contacted\."\]\.join\("\\n"\),\s*confirmKey: `qk_\$\{randomBytes\(16\)\.toString\("hex"\)\}`,/);
  assert.match(run, /action: "assistant\.action_confirmed"/);
  assert.match(run, /href: `\/jobcards\/\$\{opened\.id\}`/);
  assert.doesNotMatch(run, /prisma\.jobCard|basePrisma|send|whatsapp|email/i, "no raw job-card write, and nothing sent");

  // The door itself: module, jobcards.manage on THIS vehicle, a real priority, the numbering lock, the audit.
  const jobcards = code("src/app/actions/jobcards.ts");
  const door = jobcards.slice(jobcards.indexOf("export async function openJobCard"), jobcards.indexOf("async function claimPartStock"));
  assert.match(door, /if \(!\(await isModuleEnabled\("automotive"\)\)\)/);
  assert.match(door, /const user = await requireVehicleAccess\(vehicleId, "jobcards\.manage"\);/);
  assert.match(door, /if \(!PRIORITY_VALUES\.includes\(priority\)\) throw/);
  assert.match(door, /const number = await nextJobCardNumber\(tx\);/);
  assert.match(door, /action: "jobcard\.opened"/);
  assert.doesNotMatch(door, /redirect\(/, "the door returns; the form redirects");
  // The key is spent IN the transaction that opens the card, in this workspace (behaviour: assistantJobCardOnce.test.ts).
  const tx = door.slice(door.indexOf("basePrisma.$transaction"));
  assert.ok(tx.indexOf("tx.jobCard.create(") < tx.indexOf("tx.assistantPendingAction.create("), "key spent with the job card");
  assert.match(tx, /id: confirmKey, tenantId, userId: user\.id, card: \{ kind: "confirm_key"/);
  assert.match(door, /where: \{ id: confirmKey, tenantId \}/);
  // The form still goes through it, and still lands on the new card.
  const form = jobcards.slice(jobcards.indexOf("export async function createJobCard"), jobcards.indexOf("export async function openJobCard"));
  assert.match(form, /const jobCard = await openJobCard\(\{[\s\S]*\}\);\s*redirect\(`\/jobcards\/\$\{jobCard\.id\}`\);/);
});

test("the card shows what will be opened and links to the vehicle", () => {
  const ui = code("src/components/AssistantActionCard.tsx");
  assert.match(ui, /card\.kind === "job_card" \? `\/vehicles\/\$\{card\.vehicleId\}`/);
  assert.match(ui, /\(card\.kind === "job_card" \|\| card\.kind === "meeting"[^)]*\) && <p[^>]*whitespace-pre-line[^>]*>\{card\.detail\}<\/p>/);
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /detail: \[`Work: \$\{p\.description\}`, `Priority: \$\{priority\}`/);
});

test("WhatsApp: a job card is never confirmed from a phone — it is saved as a card for the CRM", () => {
  assert.ok(!WHATSAPP_CONFIRMABLE.has("job_card"));
  const split = splitForWhatsApp_cards([{ kind: "job_card" }, { kind: "note" }]);
  assert.deepEqual(split.crmOnly, [{ kind: "job_card" }]);
  assert.deepEqual(split.confirmable, [{ kind: "note" }]);
});

test("DAX says it can open job cards only where Automotive is on — and keeps its no-send, Confirm-only claims", async () => {
  const { selfKnowledge } = await import("../src/lib/assistantSoul");
  const on = selfKnowledge("DAX", new Set(["core", "automation", "automotive"]));
  assert.match(on, /open a workshop job card on a customer's vehicle \(it never contacts the customer\)/);
  assert.match(on, /always a test drive, a job card, a lost deal/);
  assert.match(on, /happens only when the person presses Confirm/);
  assert.match(on, /you never send anything to a customer/);
  const off = selfKnowledge("DAX", new Set(["core", "automation"]));
  assert.doesNotMatch(off, /job card/i);
});
