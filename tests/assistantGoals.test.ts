import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  GOAL_STEPS,
  evaluateGoal,
  namesQuote,
  nextBlocker,
  readGoalState,
  remindersOffText,
  startState,
  type GoalFacts,
} from "../src/lib/assistantGoalRules";
import { PROACTIVE_KINDS, proactivePush, proactiveQuestion, proactiveText } from "../src/lib/proactiveRules";
import { GOAL_SCENARIOS, scoreGoalScenario, type GoalOutcome } from "../evals/daxResearchQuality";

/* Roadmap Phase 4b: "keep an eye on this delivery until it's done" — the pure rules. */

const DAY = 86_400_000;
const t0 = new Date("2026-10-27T08:00:00Z");
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const facts = (over: Partial<GoalFacts> = {}): GoalFacts => ({
  ref: "Q-1042", depositPaid: false, invoiced: false, stock: [], deliveryScheduledFor: null, delivered: false, lost: false, ...over,
});
const ready: Partial<GoalFacts> = { depositPaid: true, invoiced: true, stock: [{ pdiStatus: "passed" }] };

test("the next blocker is the first step not done, in order: deposit → documents → prep → booking → delivered", () => {
  assert.deepEqual(GOAL_STEPS, ["deposit", "documents", "prep", "booking", "delivered"]);
  assert.equal(nextBlocker(facts()), "deposit");
  // Booked before the deposit is in: the deposit still holds it up.
  assert.equal(nextBlocker(facts({ deliveryScheduledFor: at(3) })), "deposit");
  assert.equal(nextBlocker(facts({ depositPaid: true })), "documents");
  assert.equal(nextBlocker(facts({ depositPaid: true, invoiced: true })), "prep");
  assert.equal(nextBlocker(facts({ depositPaid: true, invoiced: true, stock: [{ pdiStatus: "passed" }, { pdiStatus: "in_progress" }] })), "prep", "every cart through its PDI");
  assert.equal(nextBlocker(facts({ depositPaid: true, invoiced: true, stock: [{ pdiStatus: "ready_for_delivery" }] })), "booking");
  assert.equal(nextBlocker(facts({ ...ready, deliveryScheduledFor: at(2) })), "delivered");
  assert.equal(nextBlocker(facts({ ...ready, deliveryScheduledFor: at(2), delivered: true })), null);
});

test("the first check after setting it up is quiet; moving on is news once, naming the next blocker", () => {
  let state = startState(facts(), t0);
  let ev = evaluateGoal(state, facts(), at(0.1));
  assert.equal(ev.outcome, "open");
  assert.equal(ev.alerts.length, 0, "they were told the blocker when they set it up");
  assert.equal(ev.next, "Waiting on the deposit");
  state = ev.state;
  ev = evaluateGoal(state, facts({ depositPaid: true }), at(1));
  assert.equal(ev.alerts.length, 1);
  assert.match(ev.alerts[0].text, /^🚚 Q-1042 moved on\. Next: the invoice\./);
  assert.deepEqual(ev.done, ["Deposit paid"]);
  // Same facts again: nothing new.
  assert.equal(evaluateGoal(ev.state, facts({ depositPaid: true }), at(1.1)).alerts.length, 0);
});

test("a stall is told once per stall, with where to act — and the customer side is the person's click, never DAX's", () => {
  const state = startState(facts(), t0);
  assert.equal(evaluateGoal(state, facts(), at(2.9)).alerts.length, 0, "under three days is not a stall");
  const stalled = evaluateGoal(state, facts(), at(3));
  assert.equal(stalled.alerts.length, 1);
  assert.match(stalled.alerts[0].text, /waiting on the deposit for 3 days/);
  assert.match(stalled.alerts[0].text, /message them from the deal — I won't contact them/);
  assert.equal(evaluateGoal(stalled.state, facts(), at(5)).alerts.length, 0, "not again for the same stall");
  // Booked, then the day passes without a handover.
  const booked = facts({ ...ready, deliveryScheduledFor: at(1) });
  const b = evaluateGoal({ ...state, blocker: "delivered" }, booked, at(1.5));
  assert.equal(b.alerts.length, 0, "the booked day isn't a day behind yet");
  const late = evaluateGoal(b.state, booked, at(2.1));
  assert.match(late.alerts[0]?.text ?? "", /was booked for .* and isn't marked delivered/);
  // Rebooked and missed again: a new stall.
  const rebooked = facts({ ...ready, deliveryScheduledFor: at(4) });
  assert.equal(evaluateGoal(late.state, rebooked, at(5.5)).alerts.length, 1);
});

test("done and lost finish the goal once; delivered wins over lost", () => {
  const state = startState(facts(), t0);
  const done = evaluateGoal(state, facts({ ...ready, deliveryScheduledFor: at(1), delivered: true }), at(2));
  assert.equal(done.outcome, "done");
  assert.match(done.alerts[0].text, /^✅ Q-1042 is delivered/);
  assert.equal(evaluateGoal(done.state, facts({ delivered: true }), at(3)).alerts.length, 0, "never told twice");
  const lost = evaluateGoal(state, facts({ lost: true }), at(2));
  assert.equal(lost.outcome, "lost");
  assert.match(lost.alerts[0].text, /deal is lost/);
  assert.equal(evaluateGoal(state, facts({ lost: true, delivered: true }), at(2)).outcome, "done");
});

test("stored state is read tolerantly; the told list stays bounded", () => {
  const s = readGoalState("garbage", t0);
  assert.equal(s.blocker, null);
  assert.deepEqual(s.told, []);
  assert.equal(readGoalState({ blocker: "nonsense", since: "x", told: Array.from({ length: 99 }, (_, i) => `k${i}`), paused: true }, t0).told.length, 30);
  assert.equal(readGoalState({ paused: true }, t0).paused, true);
});

test("a goal owns only the DAX check-backs that name its quote", () => {
  assert.ok(namesQuote("Has Anna paid the deposit on Q-1042?", 1042));
  assert.ok(namesQuote("check q1042 delivery", 1042));
  assert.ok(!namesQuote("Has Q-10421 been signed?", 1042), "not a longer number");
  assert.ok(!namesQuote("Has Q-104 been signed?", 1042));
  assert.ok(!namesQuote(null, 1042));
  assert.equal(remindersOffText(0, 0), "");
  assert.match(remindersOffText(1, 2), /switched off 1 watch and 2 check-backs/);
});

test("goal alerts ride proactive DAX: own words, a lock-screen push that names nobody, its own label", () => {
  assert.ok(PROACTIVE_KINDS.includes("delivery_goal"));
  const text = proactiveText({ kind: "delivery_goal", customer: "", url: "/deals/q1", detail: "🚚 Q-1042 moved on.", recordKey: "g:k" }, "https://crm.example.co.za");
  assert.equal(text, "🚚 Q-1042 moved on.\nhttps://crm.example.co.za/deals/q1");
  assert.doesNotMatch(proactivePush("delivery_goal"), /Q-\d/);
  assert.equal(proactiveQuestion("delivery_goal"), "A delivery you're following");
  assert.equal(proactiveQuestion("quote_opened"), "Customer activity");
});

test("eval: a goal that completes and stops its reminders scores 100; one that leaves them running scores 0", () => {
  const scenario = GOAL_SCENARIOS.find((s) => s.id === "delivery-completes-and-stops-reminders")!;
  const good: GoalOutcome = {
    status: "done",
    alerts: ["next:documents:a", "next:prep:b", "next:booking:c", "next:delivered:d", "done"],
    ownRemindersOn: 0, othersChanged: 0, pendingAlerts: 0, customerMessages: 0,
  };
  assert.equal(scoreGoalScenario(scenario, good).score, 100);
  assert.equal(scoreGoalScenario(scenario, { ...good, ownRemindersOn: 1 }).score, 0, "a reminder left running");
  assert.equal(scoreGoalScenario(scenario, { ...good, othersChanged: 1 }).score, 0, "somebody else's reminder touched");
  assert.equal(scoreGoalScenario(scenario, { ...good, customerMessages: 1 }).score, 0, "the customer contacted");
  assert.equal(scoreGoalScenario(scenario, { ...good, status: "open" }).score, 0, "never finished");
  assert.ok(scoreGoalScenario(scenario, { ...good, alerts: [...good.alerts, "done"] }).score < 100, "told twice");
  assert.ok(scoreGoalScenario(scenario, { ...good, alerts: ["done", ...good.alerts.slice(0, 4)] }).score < 100, "out of order");
});

test("wiring: the cron runs goals before the proactive sweep; job sheets and the prompt leave goals out", () => {
  const route = readFileSync("src/app/api/cron/assistant/route.ts", "utf8");
  assert.ok(route.indexOf("runDeliveryGoals(tenantId, budget)") > 0 && route.indexOf("runDeliveryGoals(tenantId, budget)") < route.indexOf("sweepProactive(tenantId, budget)"));
  const tasks = readFileSync("src/lib/assistantTask.ts", "utf8");
  assert.equal(tasks.match(/kind: \{ not: "delivery_goal" \}/g)?.length, 2, "openTasks and tasksForAskPage");
  const goals = readFileSync("src/lib/assistantGoals.ts", "utf8");
  assert.doesNotMatch(goals, /\$transaction\(\[/, "callback transactions only");
  assert.doesNotMatch(goals, /communication\.create|sendWhatsApp|sendEmail/, "never contacts the customer");
  assert.match(goals, /FOR UPDATE/);
  const page = readFileSync("src/app/(app)/assistant/page.tsx", "utf8");
  assert.match(page, /<AssistantGoalsCard userId=\{user\.id\}/);
});
