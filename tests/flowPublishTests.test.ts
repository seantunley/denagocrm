import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import type { Flow } from "../src/lib/flow";

// Review 2026-11-02 (Sean's item 6): saved tests run before a flow is published, and a failing one stops it.
type Saved = { name: string; turns: unknown; expectation: unknown };
let saved: Saved[] = [];
const stubs: Record<string, unknown> = {
  "server-only": {},
  "./db": {
    prisma: {
      botFlowEvaluation: {
        findMany: async ({ take }: { take?: number }) => saved.slice(0, take ?? saved.length),
      },
    },
  },
};
const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
const { publishTestIssues } = require("../src/lib/flowPublishTests") as typeof import("../src/lib/flowPublishTests");

const flow: Flow = {
  start: "menu",
  nodes: {
    menu: { id: "menu", type: "choice", text: "Hi! What do you need?", options: [{ id: "a", label: "Prices", next: "prices" }, { id: "b", label: "A person", next: "team" }] },
    prices: { id: "prices", type: "message", text: "Our prices start at R29,999.", next: "end" },
    team: { id: "team", type: "handoff", text: "Passing you on." },
    end: { id: "end", type: "end" },
  },
};
const test_ = (name: string, choice: string, outcome: string, replyContains = "") =>
  ({ name, turns: [{ kind: "choice", value: choice }], expectation: { outcome, ...(replyContains ? { replyContains } : {}) } });

test("passing saved tests let the publish through", async () => {
  saved = [test_("Prices path", "Prices", "completed", "R29,999"), test_("Handoff path", "A person", "handoff")];
  assert.deepEqual(await publishTestIssues("t", "f", flow, "whatsapp"), []);
  saved = [];
  assert.deepEqual(await publishTestIssues("t", "f", flow, "whatsapp"), [], "no saved tests, nothing to check");
});

test("a failing or broken saved test is a publish error that names it", async () => {
  saved = [
    test_("Prices path", "Prices", "completed", "R19,999"),
    test_("Old menu", "Book a service", "completed"),
    test_("Handoff path", "A person", "handoff"),
  ];
  const issues = await publishTestIssues("t", "f", flow, "whatsapp");
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.severity === "error" && i.code === "test.failed"));
  assert.match(issues[0].message, /“Prices path” fails on this draft: Reply did not contain “R19,999”/);
  assert.match(issues[1].message, /“Old menu” fails on this draft: Saved choice “Book a service” was not offered/);
});

test("every saved test runs: the 25th failing still blocks the publish (PR #977 review)", async () => {
  saved = Array.from({ length: 24 }, (_, i) => test_(`Case ${i}`, "Prices", "completed"));
  saved.push(test_("Case 25", "Prices", "completed", "R1"));
  const issues = await publishTestIssues("t", "f", flow, "whatsapp");
  assert.deepEqual(issues.map((i) => [i.severity, i.code]), [["error", "test.failed"]]);
  assert.match(issues[0].message, /“Case 25”/);
  const runner = readFileSync("src/lib/flowPublishTests.ts", "utf8");
  assert.doesNotMatch(runner, /take:/, "no cap on the cases a publish runs");
});

test("the tests run on the exact definition that is then published", () => {
  const publishing = readFileSync("src/lib/flowPublishing.ts", "utf8");
  const testsAt = publishing.indexOf("const tests = await publishTestIssues(tenantId, flowId, parsed, draft.channel, await flowSharedVars());");
  const txAt = publishing.indexOf("return withTenantWrite(async (tx) => {");
  assert.ok(testsAt > 0 && txAt > testsAt, "tests run before the publishing transaction");
  assert.match(publishing, /if \(flowErrors\(tests\)\.length\) throw new FlowPublishValidationError\(\[\.\.\.issues, \.\.\.tests\]\);/);
  // …and the transaction refuses a draft that changed after it was tested.
  assert.match(publishing, /if \(flow\.definition !== draft\.definition\) throw new Error\("FLOW_CHANGED_DURING_PUBLISH"\);/);
});
