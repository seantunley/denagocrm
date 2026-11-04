import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { journeyFollowUp, runFlow, type Flow, type JourneyFollowUp } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";
import { handedOverVars } from "../src/lib/journeyVariables";
import { JOURNEY_LIMITS } from "../src/lib/journeyTypes";

// Review 2026-11-02 (Sean's item 5): chatbot follow-ups go THROUGH Journeys — the flow names when the Journey starts
// and which answers it gets; the Journey runner does the waiting and the sending.

type JourneyNode = Extract<Flow["nodes"][string], { type: "journey" }>;
const node = (extra: Partial<JourneyNode> = {}): JourneyNode => ({ id: "j", type: "journey", journeyId: "jr", next: "end", ...extra });

test("the follow-up time and the handed-over answers", () => {
  const vars = { name: "Thandi", model: "Rover XL", phone: "" };
  assert.deepEqual(journeyFollowUp(node(), vars), { delayMinutes: 0, handOver: {} });
  assert.deepEqual(journeyFollowUp(node({ after: { amount: 2, unit: "days" }, handOver: ["name", "model", "phone", "missing"] }), vars), {
    delayMinutes: 2880,
    handOver: { name: "Thandi", model: "Rover XL" },
  }, "an empty or unset answer is not handed over");
  assert.equal(journeyFollowUp(node({ after: { amount: 90, unit: "days" } }), vars).delayMinutes, 30 * 1440, "capped at 30 days");
  assert.equal(journeyFollowUp(node({ after: { amount: -3, unit: "hours" } }), vars).delayMinutes, 0);
});

test("the engine hands the follow-up to the Journey bridge", async () => {
  let got: JourneyFollowUp | undefined;
  const flow: Flow = { start: "j", nodes: { j: node({ after: { amount: 3, unit: "hours" }, handOver: ["name"] }), end: { id: "end", type: "end" } } };
  await runFlow(flow, { nodeId: null, vars: { name: "Sipho" } }, { text: "" }, {
    aiReply: async () => ({ reply: "", handoff: false }), dynamicAnswer: async () => "", createBooking: async () => ({ ok: true }), handoff: async () => {},
    startJourney: async (_id, _vars, _nodeId, followUp) => { got = followUp; return { ok: true }; },
  });
  assert.deepEqual(got, { delayMinutes: 180, handOver: { name: "Sipho" } });
});

test("handed-over answers follow a Set-variables step's rules — and a bad one is left out, not fatal", () => {
  assert.deepEqual(handedOverVars({ name: "A", "bad name": "x", _x: "y", __proto__x: "z" }), { name: "A" });
  assert.equal(handedOverVars({ long: "x".repeat(2000) }).long.length, JOURNEY_LIMITS.variableChars);
  const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`v${i}`, "x"]));
  assert.equal(Object.keys(handedOverVars(many)).length, JOURNEY_LIMITS.variables);
  const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`v${i}`, "y".repeat(490)]));
  assert.ok(JSON.stringify(handedOverVars(big)).length <= JOURNEY_LIMITS.variableBytes);
});

test("publish checks: a follow-up past 30 days is an error; an unusable name is a warning", () => {
  const flow = (extra: Partial<JourneyNode>): Flow => ({ start: "j", nodes: { j: node(extra), end: { id: "end", type: "end" } } });
  assert.ok(validateFlow(flow({ after: { amount: 31, unit: "days" } })).some((i) => i.code === "journey.after_range" && i.severity === "error"));
  assert.ok(!validateFlow(flow({ after: { amount: 30, unit: "days" } })).some((i) => i.code === "journey.after_range"));
  assert.ok(validateFlow(flow({ handOver: ["first-name"] })).some((i) => i.code === "journey.hand_over_name" && i.severity === "warning"));
});

test("the run is due at the follow-up time and starts with the answers as its variables", () => {
  const shared = readFileSync("src/lib/journeyEngineShared.ts", "utf8");
  // Before the entry conditions, so a Journey's entry rules can read vars.x too.
  assert.match(shared, /const context = withJourneyVars\(loaded, args\.vars \?\? \{\}\);\s*const conditions = parseConditionGroup/);
  assert.match(shared, /\.\.\.\(args\.startAt \? \{ nextRunAt: args\.startAt \} : \{\}\)/);
  const direct = readFileSync("src/lib/journeyDirectEnrollment.ts", "utf8");
  assert.match(direct, /vars: handedOverVars\(input\.handOver \?\? \{\}\)/, "sanitised at the Journey's own door");
  assert.match(direct, /Math\.min\(Math\.max\(0, Math\.round\(input\.delayMinutes \?\? 0\)\), JOURNEY_LIMITS\.waitDays \* 1440\)/);
  const actions = readFileSync("src/lib/flowActions.ts", "utf8");
  assert.match(actions, /payload: \{ channel: source, flowNodeId: nodeId \},\s*delayMinutes: followUp\?\.delayMinutes,\s*handOver: followUp\?\.handOver,/);
});
