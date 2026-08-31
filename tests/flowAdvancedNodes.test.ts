import assert from "node:assert/strict";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

function ctx(overrides: Partial<FlowCtx> = {}): FlowCtx {
  return {
    aiReply: async () => ({ reply: "AI", handoff: false }),
    dynamicAnswer: async () => "dynamic",
    createBooking: async () => ({ ok: true }),
    handoff: async () => {},
    ...overrides,
  };
}

test("set variable and switch route deterministically", async () => {
  const flow: Flow = { start: "set", nodes: {
    set: { id: "set", type: "set", variable: "intent", value: "sales", next: "switch" },
    switch: { id: "switch", type: "switch", variable: "intent", cases: [{ id: "sales", value: "sales", next: "yes" }], defaultNext: "no" },
    yes: { id: "yes", type: "message", text: "sales route", next: "end" },
    no: { id: "no", type: "message", text: "default route", next: "end" },
    end: { id: "end", type: "end" },
  }};
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, ctx());
  assert.deepEqual(result.messages, [{ type: "text", text: "sales route" }]);
});

test("knowledge answer is grounded through its callback and may save the answer", async () => {
  const flow: Flow = { start: "k", nodes: { k: { id: "k", type: "knowledge", query: "warranty", saveAs: "answer", next: "m", failureNext: "end" }, m: { id: "m", type: "message", text: "Saved: {{answer}}", next: "end" }, end: { id: "end", type: "end" } } };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, ctx({ knowledgeAnswer: async () => ({ ok: true, text: "Approved warranty fact" }) }));
  assert.equal(result.messages[0]?.type, "text");
  assert.equal(result.messages[0]?.type === "text" ? result.messages[0].text : "", "Approved warranty fact");
  assert.equal(result.messages[1]?.type === "text" ? result.messages[1].text : "", "Saved: Approved warranty fact");
});

test("AI extract only merges configured fields", async () => {
  const flow: Flow = { start: "x", nodes: { x: { id: "x", type: "extract", instruction: "extract", fields: ["city"], next: "m", failureNext: "end" }, m: { id: "m", type: "message", text: "{{city}}/{{ignored}}", next: "end" }, end: { id: "end", type: "end" } } };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "Cape Town" }, ctx({ extractData: async () => ({ ok: true, values: { city: "Cape Town", ignored: "must not leak" } }) }));
  assert.equal(result.messages[0]?.type === "text" ? result.messages[0].text : "", "Cape Town/");
});

test("API request stores response and uses explicit failure branch", async () => {
  const base: Flow = { start: "api", nodes: { api: { id: "api", type: "http", method: "GET", url: "https://example.com", saveAs: "payload", next: "ok", failureNext: "fail" }, ok: { id: "ok", type: "message", text: "{{payload}}", next: "end" }, fail: { id: "fail", type: "message", text: "failed", next: "end" }, end: { id: "end", type: "end" } } };
  const good = await runFlow(base, { nodeId: null, vars: {} }, { text: "" }, ctx({ httpRequest: async () => ({ ok: true, status: 200, body: "hello" }) }));
  assert.equal(good.messages[0]?.type === "text" ? good.messages[0].text : "", "hello");
  const bad = await runFlow(base, { nodeId: null, vars: {} }, { text: "" }, ctx({ httpRequest: async () => ({ ok: false, status: 500 }) }));
  assert.equal(bad.messages[0]?.type === "text" ? bad.messages[0].text : "", "failed");
});

test("wait pauses and resumes only after its deadline", async () => {
  const flow: Flow = { start: "wait", nodes: { wait: { id: "wait", type: "delay", seconds: 5, next: "done" }, done: { id: "done", type: "message", text: "resumed", next: "end" }, end: { id: "end", type: "end" } } };
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, ctx());
  assert.equal(first.session?.nodeId, "wait");
  const still = await runFlow(flow, first.session!, { text: "ping" }, ctx());
  assert.equal(still.session?.nodeId, "wait");
  const expired = { ...first.session!, vars: { ...first.session!.vars, __flow_delay_wait: String(Date.now() - 1) } };
  const resumed = await runFlow(flow, expired, { text: "ping" }, ctx());
  assert.equal(resumed.messages[0]?.type === "text" ? resumed.messages[0].text : "", "resumed");
});

test("synchronous published subflow returns output and variables to parent", async () => {
  const child: Flow = { start: "set", nodes: { set: { id: "set", type: "set", variable: "child_value", value: "yes", next: "say" }, say: { id: "say", type: "message", text: "child", next: "end" }, end: { id: "end", type: "end" } } };
  const parent: Flow = { start: "sub", nodes: { sub: { id: "sub", type: "subflow", flowId: "child", next: "say", failureNext: "fail" }, say: { id: "say", type: "message", text: "parent {{child_value}}", next: "end" }, fail: { id: "fail", type: "message", text: "failed", next: "end" }, end: { id: "end", type: "end" } } };
  const result = await runFlow(parent, { nodeId: null, vars: {} }, { text: "" }, ctx({ loadSubflow: async (id) => id === "child" ? child : null }));
  assert.deepEqual(result.messages.map((message) => message.type === "text" ? message.text : message.type), ["child", "parent yes"]);
});

test("human handoff carries configured reason and summary", async () => {
  let context: unknown;
  const flow: Flow = { start: "h", nodes: { h: { id: "h", type: "handoff", text: "One moment", reason: "Sales", summary: "Interested in {{model}}" } } };
  const result = await runFlow(flow, { nodeId: null, vars: { model: "Rover XL" } }, { text: "" }, ctx({ handoff: async (_vars, handoffContext) => { context = handoffContext; } }));
  assert.equal(result.handedOff, true);
  assert.deepEqual(context, { confidence: undefined, intent: undefined, reason: "Sales", summary: "Interested in Rover XL" });
});

test("advanced nodes participate in validation and variable discovery", () => {
  const flow: Flow = { start: "set", nodes: { set: { id: "set", type: "set", variable: "segment", value: "vip", next: "sw" }, sw: { id: "sw", type: "switch", variable: "segment", cases: [{ id: "vip", value: "vip", next: "end" }], defaultNext: "end" }, end: { id: "end", type: "end" } } };
  assert.equal(validateFlow(flow).filter((entry) => entry.severity === "error").length, 0);
});
