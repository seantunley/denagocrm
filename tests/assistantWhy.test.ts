import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  NOT_RECORDED,
  WHY_LEGEND,
  WHY_MAX_EVENTS,
  auditCause,
  auditEvents,
  describeChanges,
  journeyEvents,
  notEnrolledEvents,
  quoteEvents,
  sendCause,
  sendEvents,
  whyTimeline,
  type WhyEvent,
} from "../src/lib/assistantWhy";
import { assistantStep, lookupStatus, planInstructions } from "../src/lib/crmAssistantPlan";

// "Why did this happen?" — DAX explains a record's events from what the records
// SAY caused them, and says plainly when they don't.

const at = new Date("2026-10-12T08:05:00Z"); // 10:05 in South Africa
const STAND_IN = "u_owner";
const send = { occurredAt: at, direction: "outbound", type: "email", subject: null, body: "Hello", user: { id: "u_don", name: "Donovan" } };

test("a message's cause: the journey, the chatbot, the customer, or the account it is under", () => {
  assert.equal(sendCause({ ...send, body: "[Journey: Service due]\n\nYour cart is due", user: { id: STAND_IN, name: "Sean" } }, STAND_IN), 'journey "Service due"');
  assert.equal(sendCause({ ...send, type: "whatsapp", subject: "🤖 Assistant" }, STAND_IN), "chatbot (AI reply)");
  assert.match(sendCause({ ...send, type: "whatsapp", subject: "🤖 Assistant → handoff" }, STAND_IN), /handed the chat over/);
  assert.equal(sendCause({ ...send, subject: "🤖 Auto-reply (price)" }, STAND_IN), 'chatbot auto-reply (keyword rule "price")');
  assert.equal(sendCause({ ...send, subject: "🤖 Auto-reply (after-hours)" }, STAND_IN), "chatbot auto-reply (after-hours message)");
  assert.equal(sendCause({ ...send, subject: "🤖 Flow" }, STAND_IN), "chatbot flow");
  assert.equal(sendCause({ ...send, direction: "inbound", type: "whatsapp", user: { id: STAND_IN, name: "Sean" } }, STAND_IN), "the customer");
  assert.equal(sendCause(send, STAND_IN), "person: Donovan");
  // The stand-in account is "that person OR automatic" — never certain (assistantWho).
  assert.equal(sendCause({ ...send, user: { id: STAND_IN, name: "Sean" } }, STAND_IN), "filed under Sean or an automatic entry");
  assert.equal(sendCause(send, null), "filed under Donovan or an automatic entry", "stand-in unknown: nobody is certain");
  assert.equal(sendCause({ ...send, user: null }, STAND_IN), NOT_RECORDED);
});

test("a sent email carries the open/bounce facts, and the journey marker is not repeated as text", () => {
  const [e] = sendEvents([{ ...send, body: "[Journey: Welcome]\n\nHi Anna", openToken: "t", seenAt: at, bouncedAt: null }], STAND_IN);
  assert.equal(e.when, "2026-10-12 10:05");
  assert.equal(e.text, "Hi Anna");
  assert.equal(e.emailOpen, "opened");
  const [bounced] = sendEvents([{ ...send, messageId: "<m@x>", bouncedAt: at, bounceReason: "mailbox full" }], STAND_IN);
  assert.deepEqual(bounced.notDelivered, { at: at.toISOString(), reason: "mailbox full" });
});

test("an audit entry: a person by name, or the automatic writer by name", () => {
  assert.equal(auditCause({ userId: "u1", userName: "Donovan" }), "person: Donovan");
  assert.equal(auditCause({ userId: null, userName: "Journey engine" }), "automatic: Journey engine");
  assert.equal(auditCause({ userId: null, userName: "" }), "automatic: System");
});

test("before → after in words: stage and people ids named, unknown ids and contact details withheld", () => {
  const names = new Map([["cstagenew00000000000000", "New"], ["cstagelost0000000000000", "Lost"], ["cuserdon000000000000000", "Donovan"]]);
  const changed = describeChanges({
    empty: false,
    changed: [
      { field: "stageId", before: "cstagenew00000000000000", after: "cstagelost0000000000000" },
      { field: "assignedToId", before: null, after: "cuserdon000000000000000" },
      { field: "productId", before: "cprodunknown00000000000", after: "cprodother0000000000000" },
      { field: "email", before: "a@x.co", after: "b@x.co" },
      { field: "position", before: 1, after: 2 },
    ],
  }, names);
  assert.deepEqual(changed, ["stageId: New → Lost", "assignedToId: (empty) → Donovan", "productId: (a record) → (a record)", "email: changed"]);
  assert.ok(!changed.join(" ").includes("@"), "no email address reaches the model");
  const [row] = auditEvents([{ id: "a1", action: "lead.stage_changed", summary: "Moved “Cart” to Lost", userId: "u1", userName: "Donovan", createdAt: at }], { a1: { empty: false, changed: [{ field: "stageId", before: "cstagenew00000000000000", after: "cstagelost0000000000000" }] } }, names);
  assert.equal(row.cause, "person: Donovan");
  assert.deepEqual(row.changed, ["stageId: New → Lost"]);
});

test("journeys: each run's steps and why it stopped; triggers that did NOT enrol and why", () => {
  const [run] = journeyEvents([{
    journeyName: "Win-back", status: "failed", createdAt: at, completedAt: null, lastError: "no marketing consent",
    steps: [
      { stepType: "wait", status: "completed", note: null, startedAt: new Date(at.getTime() + 60_000) },
      { stepType: "send_email", status: "skipped", note: "quiet hours", startedAt: new Date(at.getTime() + 120_000) },
    ],
  }]);
  assert.equal(run.cause, 'journey "Win-back"');
  assert.deepEqual(run.steps, ["2026-10-12 10:06 wait completed", "2026-10-12 10:07 send_email skipped — quiet hours"]);
  assert.equal(run.stoppedBecause, "no marketing consent");
  const done = journeyEvents([{ journeyName: "W", status: "completed", createdAt: at, completedAt: at, lastError: "old", steps: [] }])[0];
  assert.ok(!("stoppedBecause" in done), "a finished run did not stop for a reason");

  const skipped = notEnrolledEvents([{ type: "lead_created", createdAt: at, decisions: [
    { journeyName: "Welcome", enrolled: true, reason: null },
    { journeyName: "Fleet", enrolled: false, reason: "entry conditions not met" },
  ] }, { type: "x", createdAt: at, decisions: null }]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].what, /"Fleet" did not enrol/);
  assert.equal(skipped[0].cause, "journey rules: entry conditions not met");
});

test("quotes: the customer's own actions and the automatic reminder, only where dated", () => {
  const events = quoteEvents([{
    number: 1031, createdAt: at, createdBy: { name: "Kristina" }, emailedAt: null, viewedAt: at, signedAt: null,
    reminderSentAt: at, declinedAt: at, declineReason: "Too expensive", changeRequestedAt: null, changeRequestNote: null,
  }]);
  assert.deepEqual(events.map((e) => [e.what, e.cause]), [
    ["Q-1031: created", "person: Kristina"],
    ["Q-1031: customer first opened the signing link", "the customer"],
    ["Q-1031: unsigned-quote reminder sent", "automatic reminder"],
    ["Q-1031: customer declined", "the customer"],
  ]);
  assert.equal(events[3].reason, "Too expensive");
});

test("the timeline: oldest first, newest WHY_MAX_EVENTS kept, sort key dropped", () => {
  const many: WhyEvent[] = Array.from({ length: WHY_MAX_EVENTS + 5 }, (_, i) => ({ when: String(i), at: 1000 - i, what: `e${i}`, cause: "x" }));
  const { events, truncated } = whyTimeline(many);
  assert.equal(truncated, true);
  assert.equal(events.length, WHY_MAX_EVENTS);
  assert.equal(events.at(-1)!.what, "e0", "the newest is last");
  assert.ok(events.every((e) => !("at" in e)));
  assert.equal(whyTimeline([]).truncated, false);
});

test("the legend: cite the event, separate guesses, say when the cause isn't recorded", () => {
  assert.match(WHY_LEGEND, /"not recorded" — the CRM does not record the cause, so SAY SO rather than guessing/);
  assert.match(WHY_LEGEND, /"My read:", never a fact/);
  assert.match(WHY_LEGEND, /cite the event/);
});

/* ── Wiring and gating, pinned on the source ─────────────────────────────── */

const lookup = readFileSync("src/lib/assistantWhyLookup.ts", "utf8");
const code = lookup.replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, "");

test("READ-ONLY: the why lookup writes nothing and logs nothing", () => {
  assert.doesNotMatch(code, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|logAudit|logError|console\./);
});

test("ONLY WHAT THEY MAY OPEN: every way in goes through the page guards", () => {
  assert.match(code, /openableLead = async[^\n]*seesLeads\(u\)\)\s*&&\s*\(await canAccessLead\(u, id\)\)/);
  assert.match(code, /openableContact = async[^\n]*seesContacts\(u\)\)\s*&&\s*\(await canAccessContact\(u, id\)\)/);
  assert.match(code, /q && \(await canAccessQuote\(user, q\.id\)\)/);
  assert.match(code, /seesInbox\(user\)\)\s*&&\s*\(await canAccessConversation\(user, needle\)\)/);
  // A lead's customer joins its timeline only when that customer may be opened, as on the lead page.
  assert.match(code, /target\.contactId \?\? \(await openableContact\(user, lead\?\.contactId\)\)/);
  // By name: only the leads / customers their lists show.
  assert.match(code, /getAccessibleLeadIds\(user\)[\s\S]{0,200}id: \{ in: ids \}/);
  assert.match(code, /getAccessibleContactIds\(user\)[\s\S]{0,200}id: \{ in: ids \}/);
  // A customer's history: only the deals they may open (customerHistory / customerTimeline, as the customer page).
  assert.match(code, /viewableDealIds\([\s\S]{0,160}getAccessibleLeadIds\(user\)\)/);
  assert.match(code, /customerHistoryWhere\(contactId, dealIds\)/);
  assert.match(code, /customerTimelineWhere\(contactId, dealIds\)/);
  assert.match(code, /getAccessibleQuoteIds\(user\)/);
  // The bot's session and flow events: the conversation's own workspace, named in the query.
  assert.match(code, /canAccessConversation\(user, conversationId\)/);
  assert.match(code, /const where = \{ tenantId: conversation\.tenantId, channel: identity\.channel \}/);
  assert.match(code, /botFlowVersion\.findMany\(\{ where: \{ tenantId: conversation\.tenantId/);
  assert.match(code, /botFlow\.findMany\(\{ where: \{ tenantId: conversation\.tenantId/);
});

test("MODULES: journeys only with Marketing on (and journeys.manage); the bot only with Automation on (and inbox access)", () => {
  assert.match(code, /if \(await isModuleEnabled\("marketing"\)\) \{\s*if \(await hasPermission\(user, "journeys\.manage"\)\)/);
  assert.match(code, /if \(\(await isModuleEnabled\("automation"\)\) && \(await seesInbox\(user\)\)\)/);
  // Nothing reads journeys or the bot outside those blocks.
  const journeyReads = code.match(/prisma\.journey\w*\./g) ?? [];
  assert.equal(journeyReads.length, 2);
  const marketingBlock = code.slice(code.indexOf('isModuleEnabled("marketing")'), code.indexOf('isModuleEnabled("automation")'));
  assert.equal((marketingBlock.match(/prisma\.journey\w*\./g) ?? []).length, 2);
  assert.ok(code.indexOf("botFacts(user") > code.indexOf('isModuleEnabled("automation")'));
});

test("PLANNER: why is a tool with one required argument, described for 'why did…' questions", () => {
  assert.ok(assistantStep.safeParse({ tool: "why", args: { record: "Anna" } }).success);
  assert.ok(assistantStep.safeParse({ tool: "why", args: { record: "Q-1031" } }).success);
  assert.ok(!assistantStep.safeParse({ tool: "why", args: {} }).success);
  assert.ok(!assistantStep.safeParse({ tool: "why", args: { record: "Anna", sql: "drop" } }).success, "nothing outside the schema");
  const plan = planInstructions({ today: "2026-10-26", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /- why: \{"record":/);
  assert.match(plan, /every "why did…" \/ "how come…" \/ "who moved \/ sent \/ assigned…" question/);
  assert.equal(lookupStatus([{ tool: "why", args: { record: "Anna" } }]), "Going through the record's history…");
  const assistant = readFileSync("src/lib/crmAssistant.ts", "utf8");
  assert.match(assistant, /case "why": return whyLookup\(user, step\.args\.record\);/);
});

test("SELF-KNOWLEDGE: it can explain why, and names journeys / the chatbot only when those modules are on", async () => {
  const { selfKnowledge } = await import("../src/lib/assistantSoul");
  const all = selfKnowledge("DAX", new Set(["core", "marketing", "automation"]));
  assert.match(all, /explain WHY something happened/);
  assert.match(all, /say plainly when the CRM doesn't record why/);
  assert.match(all, /the journey and step that sent it/);
  assert.match(all, /why the chatbot handed a chat over/);
  const bare = selfKnowledge("DAX", new Set(["core"]));
  assert.match(bare, /explain WHY something happened/);
  assert.doesNotMatch(bare, /journey and step/);
  assert.doesNotMatch(bare, /chatbot handed/);
});
