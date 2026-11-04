import assert from "node:assert/strict";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's disable node (Sean, 2026-11-04): skip a step without deleting it.
const ctx = {
  handoff: async () => {},
  aiReply: async () => ({ reply: "", handoff: false }),
  dynamicAnswer: async () => "[price list]",
  createBooking: async () => ({ ok: true }),
} as unknown as FlowCtx;

const flow = (off: boolean): Flow => ({
  start: "hi",
  nodes: {
    hi: { id: "hi", type: "message", text: "Hello", next: "prices" },
    prices: { id: "prices", type: "answer", answerSource: "pricelist", next: "bye", ...(off ? { off: true } : {}) },
    bye: { id: "bye", type: "message", text: "Bye", next: "end" },
    end: { id: "end", type: "end" },
  },
});

test("a switched-off step is skipped: not sent, not counted, and the customer carries on", async () => {
  const seen: string[] = [];
  const on = await runFlow(flow(false), { nodeId: null, vars: {} }, { text: "hi" }, { ...ctx, onStep: (id) => seen.push(id) });
  assert.deepEqual(on.messages.map((m) => (m.type === "text" ? m.text : "")), ["Hello", "[price list]", "Bye"]);
  seen.length = 0;
  const off = await runFlow(flow(true), { nodeId: null, vars: {} }, { text: "hi" }, { ...ctx, onStep: (id) => seen.push(id) });
  assert.deepEqual(off.messages.map((m) => (m.type === "text" ? m.text : "")), ["Hello", "Bye"]);
  assert.deepEqual(seen, ["hi", "bye", "end"], "the step numbers don't count a skipped step");
});

test("a switched-off question is not asked; nothing after it ends the conversation there", async () => {
  const f: Flow = { start: "ask", nodes: { ask: { id: "ask", type: "capture", text: "Your name?", variable: "name", off: true } } };
  const result = await runFlow(f, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  assert.deepEqual(result.messages, []);
  assert.equal(result.session, null);
  assert.ok(validateFlow(f).some((i) => i.code === "step.off" && i.severity === "warning" && /conversation ends here/.test(i.message)));
});

test("a branching step can't be switched off: the engine ignores the flag and the builder says why", async () => {
  const f: Flow = {
    start: "c",
    nodes: {
      c: { id: "c", type: "condition", condition: { variable: "x", operator: "empty" }, trueNext: "yes", falseNext: "no", off: true },
      yes: { id: "yes", type: "message", text: "Yes" },
      no: { id: "no", type: "message", text: "No" },
    },
  };
  const result = await runFlow(f, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  assert.deepEqual(result.messages.map((m) => (m.type === "text" ? m.text : "")), ["Yes"], "still runs");
  assert.ok(validateFlow(f).some((i) => i.code === "step.off_unsupported" && i.severity === "error"));
});

test("every switched-off step is flagged so none is published by accident", () => {
  const issues = validateFlow(flow(true));
  assert.ok(issues.some((i) => i.code === "step.off" && i.nodeId === "prices" && /straight on/.test(i.message)));
  assert.ok(!validateFlow(flow(false)).some((i) => i.code.startsWith("step.off")));
});
