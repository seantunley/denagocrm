import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's notification nodes (Sean, 2026-11-04): tell a staff member, the bot carries on.
const base = {
  handoff: async () => {},
  aiReply: async () => ({ reply: "", handoff: false }),
  dynamicAnswer: async () => "",
  createBooking: async () => ({ ok: true }),
} as unknown as FlowCtx;

const flow: Flow = {
  start: "ask",
  nodes: {
    ask: { id: "ask", type: "capture", text: "Your name?", variable: "name", next: "tell" },
    tell: { id: "tell", type: "notify", userId: "u1", userLabel: "Sean", text: "{{name}} just asked for the price list", next: "bye" },
    bye: { id: "bye", type: "message", text: "Thanks {{name}}!" },
  },
};

test("the chosen person is told, with the answers filled in, and the bot carries on", async () => {
  const told: unknown[] = [];
  const actions: [string, string, boolean][] = [];
  const ctx = { ...base, notifyStaff: async (input: unknown) => { told.push(input); return { ok: true }; }, recordAction: (n: string, a: string, ok: boolean) => actions.push([n, a, ok]) } as FlowCtx;
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  const done = await runFlow(flow, first.session!, { text: "Thandi" }, ctx);
  assert.deepEqual(told, [{ userId: "u1", userLabel: "Sean", text: "Thandi just asked for the price list", nodeId: "tell" }]);
  assert.deepEqual(done.messages.map((m) => (m.type === "text" ? m.text : "")), ["Thanks Thandi!"], "the customer is not told about it");
  assert.deepEqual(actions, [["tell", "notify", true]]);
});

test("if it can't reach them, the customer still carries on — and it is recorded as not done", async () => {
  const actions: [string, string, boolean][] = [];
  const ctx = { ...base, notifyStaff: async () => { throw new Error("push down"); }, recordAction: (n: string, a: string, ok: boolean) => actions.push([n, a, ok]) } as unknown as FlowCtx;
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  const done = await runFlow(flow, first.session!, { text: "Thandi" }, ctx);
  assert.deepEqual(done.messages.map((m) => (m.type === "text" ? m.text : "")), ["Thanks Thandi!"]);
  assert.deepEqual(actions, [["tell", "notify", false]]);
});

test("the builder insists on a person and a message", () => {
  const blank: Flow = { start: "t", nodes: { t: { id: "t", type: "notify", text: " " } } };
  const codes = validateFlow(blank).map((i) => i.code);
  assert.ok(codes.includes("notify.who") && codes.includes("notify.text"));
  assert.ok(!validateFlow(flow).some((i) => i.code.startsWith("notify.")));
});

test("live: the person's Ask history, their phone and linked WhatsApp; logged without the customer's words", () => {
  const code = readFileSync("src/lib/flowNotify.ts", "utf8");
  assert.match(code, /if \(!\(await hasAnyPermission\(user, "inbox\.view", "inbox\.reply"\)\)\) return \{ ok: false/);
  assert.match(code, /source: "flow_notify"/);
  // Once per inbound event and step: the alert's id comes from that key, so a redelivery hits the primary key.
  assert.match(code, /\.\.\.\(input\.dedupeKey \? \{ id: notifyTurnId\(input\.dedupeKey\) \} : \{\}\)/);
  assert.match(code, /if \(\(error as \{ code\?: string \}\)\.code === "P2002"\) return \{ ok: true \};/);
  assert.ok(code.indexOf("assistantTurn.create(") < code.indexOf("sendPushToAll("), "the push only follows a NEW alert");
  assert.match(readFileSync("src/lib/flowActions.ts", "utf8"), /dedupeKey: botActionKey\(input\.nodeId, "notify"\)/);
  assert.match(code, /"bot_notify", \{ tenantId, userId: user\.id \}\)/, "a push to that one person only");
  assert.match(code, /summary: `Chatbot told \$\{user\.name\} about this \$\{channel\} conversation`/, "the audit names the person, not the text");
  assert.match(readFileSync("src/lib/assistantWhatsAppRules.ts", "utf8"), /"flow_notify"\] as const;/, "delivered to the linked phone like a handoff");
  for (const rel of ["src/app/actions/flowSimulator.ts", "src/lib/flowEvaluationRunner.ts"]) {
    assert.match(readFileSync(rel, "utf8"), /notifyStaff: async \(input\) => \{ trace\.push\(`Tell: node \$\{input\.nodeId\} would tell/, `${rel} only describes it`);
  }
});
