import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  PLAN_INSTRUCTIONS,
  PLAN_MAX_STEPS,
  RETRY_SAFE_KINDS,
  SEND_KINDS,
  cardForStep,
  parsePlan,
  pdfAlreadySent,
  planView,
  stepStatusFor,
  type PlanState,
  type PlanStep,
} from "../src/lib/assistantPlanRules";
import { REPLY_MARKER, splitReply } from "../src/lib/assistantReply";
import { MAX_ACTIONS, claimsSetUp, settledAnswer, type ActionCard } from "../src/lib/assistantActions";
import { PLAN_SCENARIOS, scorePlanScenario, type PlanOutcome } from "../evals/daxResearchQuality";

/*
 * DAX multi-step plans (roadmap Phase 3). The pure rules directly; the wiring by
 * its source. The runner itself — locks, claims, Confirm twice, interrupted and
 * refused steps — is proved on a real database by scripts/test-assistant-plans.ts.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(path.join(root, p), "utf8");
const LEAD = "lead_000000000001";

const build: ActionCard = { id: "a0-x", kind: "quote_build", leadId: null, leadLabel: "Anna", title: "Create a draft quote for Anna", contactId: "contact_00000001", lines: [], text: "", confirmKey: "qk_" + "a".repeat(32) };
const pdf: ActionCard = { id: "p1-pdf", kind: "quote_pdf", leadId: null, leadLabel: "Anna", quoteId: "", quoteNumber: 0, title: "Send me the PDF of the new quote" };
const note: ActionCard = { id: "a2-x", kind: "note", leadId: LEAD, leadLabel: "Anna", title: "Add a note", text: "hi" };
const step = (n: number, card: ActionCard, over: Partial<PlanStep> = {}): PlanStep => ({ n, key: `ps_${n}`, title: card.title, card, status: "waiting", ...over });
const state = (steps: PlanStep[], expiresAt = new Date(Date.now() + 3_600_000).toISOString()): PlanState => ({ v: 1, expiresAt, steps, sends: [] });
const task = { id: "plan_1", title: "Quote Anna", status: "open", quoteId: null };

test("a plan block parses: steps are tasks as in actions, dependsOn renumbered past a dropped step", () => {
  const plan = parsePlan({
    title: "Quote Anna, PDF, remind me",
    steps: [
      { type: "quote_build", contactId: "contact_00000001", lines: [{ productId: "product_000001", qty: 1 }] },
      { type: "nonsense" },
      { type: "quote_pdf", dependsOn: 1 },
      { type: "follow_up", leadId: LEAD, when: "2026-10-30T10:00", activity: "call" },
    ],
  });
  assert.ok(plan);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.dropped, 1);
  assert.deepEqual(plan.steps.map((s) => s.action.type), ["quote_build", "quote_pdf", "follow_up"]);
  assert.equal(plan.steps[1].dependsOn, 1);
});

test("a step depending on a dropped step, or on a later one, is dropped too; check_back is never a step", () => {
  const plan = parsePlan({ steps: [{ type: "nonsense" }, { type: "quote_pdf", dependsOn: 1 }, { type: "note", leadId: LEAD, text: "x", dependsOn: 3 }, { type: "check_back", question: "q", when: "2026-10-30T10:00" }, { type: "note", leadId: LEAD, text: "ok" }] });
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.dropped, 4);
  assert.equal(plan.title, "Plan");
});

test(`at most ${PLAN_MAX_STEPS} steps; nothing valid is no plan`, () => {
  const many = parsePlan({ steps: Array.from({ length: 12 }, () => ({ type: "note", leadId: LEAD, text: "x" })) });
  assert.equal(many?.steps.length, PLAN_MAX_STEPS);
  assert.equal(many?.dropped, 4);
  assert.equal(parsePlan({ steps: [{ type: "nonsense" }] }), null);
  assert.equal(parsePlan("plan"), null);
});

test("the reply block carries a plan beside the loose actions — loose cards keep their cap", () => {
  const block = { actions: Array.from({ length: 6 }, () => ({ type: "note", leadId: LEAD, text: "x" })), plan: { title: "P", steps: [{ type: "note", leadId: LEAD, text: "a" }, { type: "note", leadId: LEAD, text: "b" }] } };
  const reply = splitReply(`Set up.\n${REPLY_MARKER}\n${JSON.stringify(block)}`);
  assert.equal(reply.actions.length, MAX_ACTIONS);
  assert.equal(reply.plan?.steps.length, 2);
  assert.equal(splitReply("No block").plan, null);
});

test("customer messages are never bundled; only keyed steps are retried after failing part-way", () => {
  assert.ok(SEND_KINDS.has("draft_message"));
  for (const kind of ["quote_build", "quote_add", "quote_change", "job_card"]) assert.ok(RETRY_SAFE_KINDS.has(kind), kind);
  for (const kind of ["note", "follow_up", "customer_note", "stage", "assign", "quote_pdf"]) assert.ok(!RETRY_SAFE_KINDS.has(kind), kind);
  assert.equal(stepStatusFor({ ok: true }), "done");
  assert.equal(stepStatusFor({ ok: false, unchanged: true }), "refused");
  assert.equal(stepStatusFor({ ok: false, resumable: true }), "refused");
  assert.equal(stepStatusFor({ ok: false }), "failed");
});

test("a later step reads an earlier result: the quote number from quote_build feeds quote_pdf", () => {
  const plan = state([step(1, build, { status: "done", quote: { id: "quote_1", number: 1042 } }), step(2, pdf, { fromStep: 1 })]);
  const card = cardForStep(plan, plan.steps[1]);
  assert.equal(card?.kind, "quote_pdf");
  assert.equal(card?.kind === "quote_pdf" && card.quoteId, "quote_1");
  assert.match(card?.title ?? "", /Q-1042/);
  assert.ok(pdfAlreadySent(plan, plan.steps[1]), "the build already queued its PDF — not sent twice");
  const none = state([step(1, build, { status: "done" }), step(2, pdf, { fromStep: 1 })]);
  assert.equal(cardForStep(none, none.steps[1]), null);
});

test("the plan reads as what ran and what didn't: waiting, paused at a step, done, expired, closed", () => {
  const waiting = planView(task, state([step(1, build), step(2, note)]));
  assert.equal(waiting.status, "waiting");
  assert.ok(waiting.canRun);
  const paused = planView(task, state([step(1, build, { status: "done" }), step(2, note, { status: "refused", message: "You can't." })]));
  assert.equal(paused.status, "paused");
  assert.match(paused.summary, /Paused at step 2 — You can't\./);
  assert.ok(paused.canRun, "a refusal (nothing written) can be retried");
  const unsafe = planView(task, state([step(1, build, { status: "done" }), step(2, note, { status: "failed", message: "Error." })]));
  assert.equal(unsafe.canRun, false, "a note that failed part-way is never run again");
  assert.match(unsafe.summary, /can't be retried/);
  const keyed = planView(task, state([step(1, build, { status: "failed", message: "Timeout." }), step(2, note)]));
  assert.ok(keyed.canRun, "a quote step carries its own key — safe to run again");
  const done = planView({ ...task, status: "done" }, state([step(1, build, { status: "done" }), step(2, note, { status: "done" })]));
  assert.equal(done.status, "done");
  assert.equal(done.canRun, false);
  const expired = planView(task, state([step(1, build, { status: "done" }), step(2, note)], new Date(Date.now() - 1000).toISOString()));
  assert.equal(expired.status, "expired");
  assert.equal(expired.canRun, false);
  const closed = planView({ ...task, status: "closed" }, state([step(1, build), step(2, note)]));
  assert.equal(closed.status, "closed");
  assert.equal(closed.canRun, false);
});

test("an answer that says a plan was set up when none exists is replaced", () => {
  const said = "I've set up a plan for you to confirm: the quote, the PDF and a reminder on Friday.";
  assert.ok(claimsSetUp(said));
  assert.match(settledAnswer(said, [], [], 0) ?? "", /haven't set anything up/);
  assert.match(settledAnswer(said, [{ title: "Plan: Quote Anna" }], ["Step 3 was left out: the step it depends on (1) could not be set up."], 0) ?? "", /NOT set up[\s\S]*Step 3/);
});

test("instructions: one plan, customer messages stay their own Send, never claim it is done", () => {
  assert.match(PLAN_INSTRUCTIONS, /"plan":\{"title"/);
  assert.match(PLAN_INSTRUCTIONS, /dependsOn/);
  assert.match(PLAN_INSTRUCTIONS, /NEVER run by the plan[\s\S]*Send button/);
  assert.match(PLAN_INSTRUCTIONS, /never that any of it is done/);
});

test("wiring: plans only in the CRM chat; elsewhere their steps are loose cards; the Ask page lists them", () => {
  const ask = src("src/lib/crmAssistant.ts");
  assert.match(ask, /proposes && source === "chat" \? PLAN_INSTRUCTIONS/);
  assert.match(ask, /if \(multiStep && source !== "chat"\) proposals\.push\(\.\.\.multiStep\.steps\.filter\(\(s\) => !s\.dependsOn\)/);
  assert.match(ask, /proposePlan\(user, multiStep, planProblems, \(steps, stepProblems\) => resolveActions\(user, steps, stepProblems, taskWrite\?\.ok \? taskWrite\.sheet : null\)\)/);
  // The plan card and its problems join the loose ones the answer is settled against — counted as attempted exactly
  // what they produced, so the loose tasks' came-to-nothing count is unchanged.
  assert.match(ask, /reply\.attempted \+= planCards\.length \+ planProblems\.length;\s*actions\.push\(\.\.\.planCards\);\s*problems\.push\(\.\.\.planProblems\);/);
  const tasks = src("src/lib/assistantTask.ts");
  assert.equal((tasks.match(/kind: \{ not: "plan" \}/g) ?? []).length, 2, "plans never reach the answer step's job sheets, nor the job-sheet list");
  const action = src("src/app/actions/assistantPlans.ts");
  assert.match(action, /withActingStaffScope/);
  assert.match(action, /continuePlan\(user, String\(taskId \?\? ""\), \(card\) => runAssistantAction\(card\)\)/);
  assert.match(src("src/app/(app)/assistant/page.tsx"), /<AssistantPlans plans=\{plans\} \/>/);
  // The step runner never sends: a draft message is not a step (SEND_KINDS), and runAssistantAction has no send.
  assert.doesNotMatch(src("src/lib/assistantPlan.ts"), /sendAssistantDraft|sendWhatsAppMessage|sendEmailAction/);
});

const recorded = (over: Partial<PlanOutcome>): PlanOutcome => ({ quotes: 1, followUps: 1, customerSends: 0, plan: { status: "done" }, sendCards: 1, answers: ["Plan set up for you to confirm."], ...over });
const scenario = (id: string) => PLAN_SCENARIOS.find((s) => s.id === id)!;

test("evals: the four plan scenarios exist and a correct outcome scores 100", () => {
  for (const id of ["interrupted-then-confirm-twice", "no-permission-for-one-step", "stock-unavailable-mid-plan", "werner-whole-plan"]) assert.ok(scenario(id), id);
  assert.equal(scorePlanScenario(scenario("werner-whole-plan"), recorded({})).score, 100);
  assert.equal(scorePlanScenario(scenario("no-permission-for-one-step"), recorded({ followUps: 0, plan: { status: "paused", pausedAt: 2 }, answers: ["Paused at step 2 — You don't have permission for this step."] })).score, 100);
});

test("evals: the work wasn't done but the answer sounds fine → 0", () => {
  const fluent = ["All done! I've created the quote, sent you the PDF and set your reminder for Friday."];
  assert.equal(scorePlanScenario(scenario("werner-whole-plan"), recorded({ quotes: 0, followUps: 0, plan: { status: "waiting" }, answers: fluent })).score, 0);
  assert.equal(scorePlanScenario(scenario("interrupted-then-confirm-twice"), recorded({ quotes: 2, answers: fluent })).score, 0, "made twice");
  assert.equal(scorePlanScenario(scenario("werner-whole-plan"), recorded({ customerSends: 1 })).score, 0, "a customer contacted with no Send click");
  const claimed = scorePlanScenario(scenario("no-permission-for-one-step"), recorded({ followUps: 0, plan: { status: "paused", pausedAt: 2 }, answers: ["Step 2 — all done."] }));
  assert.ok(claimed.score < 100 && claimed.checks.some((c) => c.name === "no-false-done" && !c.ok));
});
