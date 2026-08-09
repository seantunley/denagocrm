import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCondition, runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

const ctx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

test("condition comparisons are deterministic and case-insensitive", () => {
  const vars = { model: "Rover XL", empty: "" };
  assert.equal(evaluateCondition({ variable: "model", operator: "equals", value: "rover xl" }, vars), true);
  assert.equal(evaluateCondition({ variable: "model", operator: "contains", value: "ROVER" }, vars), true);
  assert.equal(evaluateCondition({ variable: "model", operator: "not_equals", value: "Nomad XL" }, vars), true);
  assert.equal(evaluateCondition({ variable: "model", operator: "exists" }, vars), true);
  assert.equal(evaluateCondition({ variable: "empty", operator: "empty" }, vars), true);
});

test("runFlow follows Yes and No condition branches without calling AI", async () => {
  let aiCalls = 0;
  const guardedCtx: FlowCtx = { ...ctx, aiReply: async () => { aiCalls += 1; return { reply: "AI", handoff: false }; } };
  const flow: Flow = {
    start: "gate",
    nodes: {
      gate: { id: "gate", type: "condition", condition: { variable: "channel", operator: "equals", value: "whatsapp" }, trueNext: "yes", falseNext: "no" },
      yes: { id: "yes", type: "message", text: "WhatsApp route", next: "end" },
      no: { id: "no", type: "message", text: "Other route", next: "end" },
      end: { id: "end", type: "end" },
    },
  };

  const yes = await runFlow(flow, { nodeId: null, vars: { channel: "whatsapp" } }, { text: "" }, guardedCtx);
  assert.deepEqual(yes.messages, [{ type: "text", text: "WhatsApp route" }]);

  const no = await runFlow(flow, { nodeId: null, vars: { channel: "instagram" } }, { text: "" }, guardedCtx);
  assert.deepEqual(no.messages, [{ type: "text", text: "Other route" }]);
  assert.equal(aiCalls, 0);
});
