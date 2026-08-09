import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx, type FlowHandoffContext } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "I'll pass that on", handoff: true }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

test("AI handoff metadata survives an intermediate graph node", async () => {
  const flow: Flow = {
    start: "ai",
    nodes: {
      ai: { id: "ai", type: "ai", handoffNext: "message" },
      message: { id: "message", type: "message", text: "One moment", next: "handoff" },
      handoff: { id: "handoff", type: "handoff" },
    },
  };
  let received: FlowHandoffContext | undefined;
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
    ...baseCtx,
    aiReply: async () => ({
      reply: "I'll get the team",
      handoff: true,
      confidence: "low",
      intent: "complaint",
      handoffReason: "Policy answer unavailable",
      handoffSummary: "Customer is unhappy about a warranty issue and needs the policy confirmed.",
    }),
    handoff: async (_vars, context) => { received = context; },
  });
  assert.equal(result.handedOff, true);
  assert.equal(received?.confidence, "low");
  assert.equal(received?.intent, "complaint");
  assert.match(received?.summary ?? "", /warranty issue/);
});

test("handoff metadata survives a waiting node through session variables", async () => {
  const flow: Flow = {
    start: "ai",
    nodes: {
      ai: { id: "ai", type: "ai", handoffNext: "capture" },
      capture: { id: "capture", type: "capture", text: "Before I pass this on, what's your phone number?", variable: "phone", next: "handoff" },
      handoff: { id: "handoff", type: "handoff" },
    },
  };
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, {
    ...baseCtx,
    aiReply: async () => ({ reply: "I'll get the team", handoff: true, confidence: "medium", intent: "purchase", handoffReason: "Payment intent", handoffSummary: "Customer wants to place an order." }),
  });
  assert.equal(first.session?.nodeId, "capture");
  assert.equal(first.session?.vars.__handoff_reason, "Payment intent");

  let received: FlowHandoffContext | undefined;
  await runFlow(flow, first.session!, { text: "0834992982" }, {
    ...baseCtx,
    handoff: async (_vars, context) => { received = context; },
  });
  assert.equal(received?.reason, "Payment intent");
  assert.equal(received?.intent, "purchase");
});

test("assistant output is strict JSON rather than regex-extracted prose", () => {
  const code = src("src/lib/botAi.ts");
  const strict = code.slice(code.indexOf("function strictJsonObject"), code.indexOf("export function parseBotDecision"));
  assert.match(strict, /JSON\.parse\(text\.trim\(\)\)/);
  assert.doesNotMatch(strict, /match\(/, "must not fish a JSON-looking object out of prose or code fences");
});

test("open-ended medium and low confidence answers hand off instead of guessing", () => {
  const code = src("src/lib/botAi.ts");
  assert.match(code, /if \(parsed\.confidence !== "high"\)/);
  assert.match(code, /confidence open question/);
  assert.match(code, /Canonical pathways may be used at medium confidence/);
});

test("handoff pushes surface the model's staff summary when one exists", () => {
  for (const rel of ["src/lib/flowRun.ts", "src/lib/flowDm.ts", "src/lib/telegram.ts"]) {
    const code = src(rel);
    assert.match(code, /context\?\.summary/);
    assert.match(code, /handoffBody\(context\)/);
  }
});
