import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stepNumbersLine } from "../src/lib/flowStepNumbers";

// Node-RED's node status, as live numbers on each step (Sean, 2026-11-02).
test("a step shows how many reached it; a question also shows answered and dropped off; nothing when none", () => {
  assert.equal(stepNumbersLine("message", { reached: 142, interacted: 0 }), "142 reached");
  assert.equal(stepNumbersLine("choice", { reached: 142, interacted: 130 }), "142 reached · 130 answered · 12 dropped off");
  assert.equal(stepNumbersLine("capture", { reached: 5, interacted: 7 }), "5 reached · 7 answered · 0 dropped off", "never negative");
  assert.equal(stepNumbersLine("message", { reached: 0, interacted: 0 }), null);
  assert.equal(stepNumbersLine("message", undefined), null);
});

test("automatic steps are counted too: the engine reports every step it runs, and both runners record it (PR #970 review)", async () => {
  const { runFlow } = await import("../src/lib/flow");
  const seen: string[] = [];
  const flow = {
    start: "hi",
    nodes: {
      hi: { id: "hi", type: "message" as const, text: "Hello", next: "ask" },
      ask: { id: "ask", type: "choice" as const, text: "Pick", options: [{ id: "a", label: "A", next: "bye" }] },
      bye: { id: "bye", type: "message" as const, text: "Bye", next: "end" },
      end: { id: "end", type: "end" as const },
    },
  };
  const ctx = {
    handoff: async () => {},
    aiReply: async () => ({ reply: "", handoff: false }),
    dynamicAnswer: async () => "",
    createBooking: async () => ({ ok: true }),
    onStep: (id: string) => { seen.push(id); },
  } as unknown as import("../src/lib/flow").FlowCtx;
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  assert.deepEqual(seen, ["hi", "ask"], "the message is counted, then the question it waits on");
  seen.length = 0;
  await runFlow(flow, first.session!, { text: "A", choiceId: "ask|a" }, ctx);
  assert.deepEqual(seen, ["bye", "end"], "the answered question is not counted twice");

  for (const rel of ["src/lib/flowRun.ts", "src/lib/flowSession.ts"]) {
    const code = readFileSync(rel, "utf8");
    assert.match(code, /ctx\.onStep = \(nodeId\) => \{ if \(snapshot\.flow\.nodes\[nodeId\]\) entered\.push\(nodeId\); \};/, rel);
    assert.match(code, /eventType: "node_entered"/, rel);
  }
  const page = readFileSync("src/app/(app)/bot-builder/[id]/page.tsx", "utf8");
  assert.match(page, /reached: Math\.max\(n\.entered, n\.reached\)/);
});

test("the numbers come from the flow's own published versions, last 30 days, and can be switched off", () => {
  const page = readFileSync("src/app/(app)/bot-builder/[id]/page.tsx", "utf8");
  assert.match(page, /botFlowVersion\.findMany\(\{ where: \{ flowId: id, tenantId: await builderTenantId\(\) \}/);
  assert.match(page, /getBotFlowVersionAnalytics\(versionIds, \{ occurredFrom: new Date\(Date\.now\(\) - STEP_NUMBERS_DAYS \* 86_400_000\) \}\)/);
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /<StepNumbersContext\.Provider value=\{showNumbers \? stepNumbers : null\}>/);
});
