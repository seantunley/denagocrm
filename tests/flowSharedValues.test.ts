import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { parseSharedValues, sharedNameProblem, sharedVars } from "../src/lib/flowSharedValues";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's context / environment variables (Sean, 2026-11-04): set once, use in any flow.
test("names: lowercase, not one the chatbot fills in itself, not twice", () => {
  assert.equal(sharedNameProblem("business_phone"), null);
  assert.match(sharedNameProblem("Business Phone")!, /lowercase/);
  assert.match(sharedNameProblem("name")!, /filled in by the chatbot/);
  assert.match(sharedNameProblem("phone")!, /filled in by the chatbot/, "a captured answer's usual name");
  assert.match(sharedNameProblem("website", ["website"])!, /already/);
});

test("stored values: anything malformed or reserved is dropped, never trusted", () => {
  const raw = JSON.stringify([{ name: "business_phone", value: "021 555 0100" }, { name: "greeting", value: "hijack" }, { name: "Bad Name", value: "x" }, "junk"]);
  assert.deepEqual(sharedVars(parseSharedValues(raw)), { business_phone: "021 555 0100" });
  assert.deepEqual(parseSharedValues("not json"), []);
});

test("in a message they are filled in like any value", async () => {
  const flow: Flow = { start: "m", nodes: { m: { id: "m", type: "message", text: "Call us on {{business_phone}}" } } };
  const ctx = { handoff: async () => {}, aiReply: async () => ({ reply: "", handoff: false }), dynamicAnswer: async () => "", createBooking: async () => ({ ok: true }) } as unknown as FlowCtx;
  const result = await runFlow(flow, { nodeId: null, vars: { business_phone: "021 555 0100" } }, { text: "hi" }, ctx);
  assert.deepEqual(result.messages, [{ type: "text", text: "Call us on 021 555 0100" }]);
});

test("validation knows them, and refuses saving an answer over one", () => {
  const flow: Flow = {
    start: "ask",
    nodes: {
      ask: { id: "ask", type: "capture", text: "Your site?", variable: "website", next: "m" },
      m: { id: "m", type: "message", text: "Call {{business_phone}}" },
    },
  };
  assert.ok(validateFlow(flow).some((i) => i.code === "variable.unknown"), "without the shared names it is unknown");
  const issues = validateFlow(flow, ["whatsapp"], ["business_phone", "website"]);
  assert.ok(!issues.some((i) => i.code === "variable.unknown"));
  assert.ok(issues.some((i) => i.code === "variable.shared" && i.nodeId === "ask" && i.severity === "error"));
});

test("read fresh every turn by both live runners, and given to the test chat, saved tests and publish checks", () => {
  for (const rel of ["src/lib/flowRun.ts", "src/lib/flowSession.ts"]) assert.match(readFileSync(rel, "utf8"), /const builtins = \{ \.\.\.\(await flowSharedVars\(\)\), \.\.\.flowRuntimeVars\(/, rel);
  assert.match(readFileSync("src/app/actions/flowSimulator.ts", "utf8"), /vars: \{ \.\.\.\(await flowSharedVars\(\)\), greeting:/);
  assert.match(readFileSync("src/app/actions/flowEvaluations.ts", "utf8"), /sharedVars: await flowSharedVars\(\)/);
  assert.match(readFileSync("src/lib/flowPublishing.ts", "utf8"), /publishTestIssues\(tenantId, flowId, parsed, draft\.channel, await flowSharedVars\(\)\)/);
  assert.match(readFileSync("src/lib/flowValidationServer.ts", "utf8"), /validateFlow\(flow, await enabledFlowChannels\(\), Object\.keys\(await flowSharedVars\(\)\)\)/);
  const actions = readFileSync("src/app/actions/flowSharedValues.ts", "utf8");
  assert.equal((actions.match(/await requireTenantOwner\(\);/g) ?? []).length, 3, "owner only, every action");
});
