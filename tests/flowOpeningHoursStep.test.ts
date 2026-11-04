import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's time-range switch, as an "Opening hours" step (Sean, 2026-11-02).
const flow: Flow = {
  start: "hours",
  nodes: {
    hours: { id: "hours", type: "hours", openNext: "team", closedNext: "closed" },
    team: { id: "team", type: "handoff", text: "Connecting you to the team…" },
    closed: { id: "closed", type: "message", text: "We're closed ({{open_now}}) — the team replies from 8am.", next: "end" },
    end: { id: "end", type: "end" },
  },
};
const ctx = (open: boolean, seen: boolean[] = []) => ({
  dynamicAnswer: async () => "", aiReply: async () => ({ reply: "", handoff: false }), handoff: async () => {},
  openNow: async (holidays: boolean) => { seen.push(holidays); return open; },
}) as unknown as FlowCtx;

test("open → the Open exit; closed → the Closed exit, with {{open_now}} stored", async () => {
  const open = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx(true));
  assert.equal(open.handedOff, true);
  const closed = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx(false));
  assert.deepEqual(closed.messages, [{ type: "text", text: "We're closed (no) — the team replies from 8am." }]);
});

test("public holidays count as closed unless the step says otherwise", async () => {
  const seen: boolean[] = [];
  await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx(true, seen));
  await runFlow({ ...flow, nodes: { ...flow.nodes, hours: { ...flow.nodes.hours, holidaysClosed: false } as Flow["nodes"][string] } }, { nodeId: null, vars: {} }, { text: "hi" }, ctx(true, seen));
  assert.deepEqual(seen, [true, false]);
});

test("validation follows both exits; every place a flow runs asks the real office hours", () => {
  assert.deepEqual(validateFlow(flow).filter((i) => i.severity === "error"), []);
  assert.ok(!validateFlow(flow).some((i) => i.code === "graph.unreachable"));
  for (const file of ["src/lib/flowRun.ts", "src/lib/flowDm.ts", "src/lib/telegram.ts", "src/app/actions/flowSimulator.ts"]) {
    assert.match(readFileSync(file, "utf8"), /openNow: \(holidaysClosed\) => chatbotOpenNow\(holidaysClosed\)/, file);
  }
});
