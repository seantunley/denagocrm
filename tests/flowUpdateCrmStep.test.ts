import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";

// "Update the CRM" (Node-RED's change node, for CRM data; Sean, 2026-11-02): tag, salesperson or deal stage.
const flow: Flow = {
  start: "tag",
  nodes: {
    tag: { id: "tag", type: "crm", action: "tag", tagName: "QR: Showroom poster", text: "Thanks — noted!", next: "end", failureNext: "sorry" },
    sorry: { id: "sorry", type: "handoff", text: "One of the team will help." },
    end: { id: "end", type: "end" },
  },
};
const ctx = (ok: boolean, seen: string[] = []) => ({
  dynamicAnswer: async () => "", aiReply: async () => ({ reply: "", handoff: false }), handoff: async () => {},
  updateCrm: async (node: { action: string; tagName?: string }) => { seen.push(`${node.action}:${node.tagName}`); return ok ? { ok: true } : { ok: false, reason: "no customer" }; },
}) as unknown as FlowCtx;

test("done → the message and the Done exit; failed → the If-it-fails exit, never the success text", async () => {
  const seen: string[] = [];
  const done = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx(true, seen));
  assert.deepEqual(done.messages, [{ type: "text", text: "Thanks — noted!" }]);
  assert.deepEqual(seen, ["tag:QR: Showroom poster"]);
  const failed = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, ctx(false));
  assert.equal(failed.handedOff, true);
  assert.ok(!failed.messages.some((m) => m.type === "text" && m.text === "Thanks — noted!"));
});

test("validation: a choice is required for each kind of change, and a failure route like any CRM action", () => {
  assert.deepEqual(validateFlow(flow).filter((i) => i.severity === "error"), []);
  const codes = (node: Flow["nodes"][string]) => validateFlow({ ...flow, nodes: { ...flow.nodes, tag: node } }).filter((i) => i.severity === "error").map((i) => i.code);
  assert.ok(codes({ id: "tag", type: "crm", action: "tag", tagName: "", next: "end", failureNext: "sorry" }).includes("crm.missing"));
  assert.ok(codes({ id: "tag", type: "crm", action: "assign", next: "end", failureNext: "sorry" }).includes("crm.missing"));
  assert.ok(codes({ id: "tag", type: "crm", action: "stage", next: "end", failureNext: "sorry" }).includes("crm.missing"));
  // The existing rule for every CRM action: no failure route straight into a step that announces success is flagged.
  const announcing: Flow = {
    start: "tag",
    nodes: {
      tag: { id: "tag", type: "crm", action: "tag", tagName: "X", next: "yay" },
      yay: { id: "yay", type: "message", text: "You're all set!", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  assert.ok(validateFlow(announcing).some((i) => i.nodeId === "tag"), "a failure would otherwise read as success");
});

test("the runtime: workspace-scoped, audited as the chatbot, and a stage move never guesses between deals", () => {
  const actions = readFileSync("src/lib/flowActions.ts", "utf8");
  const fn = actions.slice(actions.indexOf("async function updateCrmFromFlow"), actions.indexOf("async function openDeals"));
  assert.match(fn, /const tenantId = runtimeFlowTenantId\(\);/);
  assert.match(fn, /userName: "Chatbot"/);
  assert.match(fn, /tenantMember\.findFirst\(\{ where: \{ tenantId, userId: node\.userId \}/, "only a member of this workspace");
  assert.match(fn, /pipelineStage\.findFirst\(\{ where: \{ id: node\.stageId, tenantId \}/, "only this workspace's stage");
  assert.match(fn, /if \(deals\.length !== 1\) return \{ ok: false/);
  assert.match(actions, /updateCrm: \(node: Extract<FlowNode, \{ type: "crm" \}>\) => updateCrmFromFlow\(node, match\)/);
  // The simulator says what it would change, and writes nothing.
  assert.match(readFileSync("src/app/actions/flowSimulator.ts", "utf8"), /updateCrm: async \(node\) => \{ trace\.push\(`CRM: node \$\{node\.id\} would/);
});
