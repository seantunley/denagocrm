import assert from "node:assert/strict";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's link nodes, as a "Go to" step (Sean, 2026-11-02): jump to a step — "↩ Back to menu" — with no wire.
const menu: Flow = {
  start: "menu",
  nodes: {
    menu: { id: "menu", type: "choice", text: "What can I help with?", options: [{ id: "p", label: "Prices", next: "prices" }, { id: "x", label: "Something else", next: "bye" }] },
    prices: { id: "prices", type: "message", text: "Our prices are…", next: "again" },
    again: { id: "again", type: "choice", text: "Anything else?", options: [{ id: "b", label: "↩ Back to menu", next: "back" }, { id: "d", label: "Done", next: "bye" }] },
    back: { id: "back", type: "goto", target: "menu", targetLabel: "What can I help with?" },
    bye: { id: "bye", type: "message", text: "Bye!", next: "end" },
    end: { id: "end", type: "end" },
  },
};
const ctx = { dynamicAnswer: async () => "", aiReply: async () => ({ reply: "", handoff: false }), handoff: async () => {} } as unknown as FlowCtx;

test("a Go to jumps straight to its step and sends nothing itself", async () => {
  let r = await runFlow(menu, { nodeId: null, vars: {} }, { text: "hi" }, ctx);
  r = await runFlow(menu, r.session!, { text: "Prices", choiceId: "menu|p" }, ctx);
  assert.equal(r.session?.nodeId, "again");
  r = await runFlow(menu, r.session!, { text: "↩ Back to menu", choiceId: "again|b" }, ctx);
  assert.equal(r.session?.nodeId, "menu", "back at the menu");
  assert.deepEqual(r.messages.map((m) => m.type), ["choice"], "only the menu itself is sent");
});

test("validation: a jump is an edge — it must point somewhere real, not to itself, and never loop with no input", () => {
  assert.deepEqual(validateFlow(menu).filter((i) => i.severity === "error"), []);
  assert.ok(!validateFlow(menu).some((i) => i.code === "graph.unreachable"), "steps reached only through a jump count as reachable");
  const codes = (flow: Flow) => validateFlow(flow).filter((i) => i.severity === "error").map((i) => i.code);
  assert.ok(codes({ ...menu, nodes: { ...menu.nodes, back: { id: "back", type: "goto", target: "" } } }).includes("goto.missing"));
  assert.ok(codes({ ...menu, nodes: { ...menu.nodes, back: { id: "back", type: "goto", target: "back" } } }).includes("goto.self"));
  assert.ok(codes({ ...menu, nodes: { ...menu.nodes, back: { id: "back", type: "goto", target: "gone" } } }).includes("graph.missing_target"));
  const loop: Flow = { start: "a", nodes: { a: { id: "a", type: "message", text: "hi", next: "b" }, b: { id: "b", type: "goto", target: "a" } } };
  assert.ok(codes(loop).includes("graph.automatic_cycle"), "a jump back with no question in between is caught");
});
