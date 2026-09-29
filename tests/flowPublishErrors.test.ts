import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { flowErrors, publishSeverity, validateFlow, type FlowIssue } from "../src/lib/flowValidation";
import type { Flow } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** The message the action builds from a validation failure. */
function publishFailure(issues: FlowIssue[]): string {
  const errors = flowErrors(issues);
  return `This flow cannot be published yet: ${errors.slice(0, 3).map((issue) => issue.message).join(" · ")}`;
}

test("a refusal carries the compiler's own words, not a generic failure", () => {
  const unsafe: Flow = {
    start: "cancel",
    nodes: {
      cancel: { id: "cancel", type: "booking", action: "cancel", text: "Cancelling…", next: "confirm" },
      confirm: { id: "confirm", type: "message", text: "Done — your booking has been cancelled.", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const issues = publishSeverity(validateFlow(unsafe, ["whatsapp"]));
  const errors = flowErrors(issues);
  assert.ok(errors.length > 0, "this graph must be refused at publish");
  const message = publishFailure(issues);
  assert.match(message, /cannot be published/);
  assert.ok(message.includes(errors[0].message));
});

test("a publishable graph produces no refusal", () => {
  const fine: Flow = {
    start: "hello",
    nodes: {
      hello: { id: "hello", type: "message", text: "Hi", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  assert.deepEqual(flowErrors(publishSeverity(validateFlow(fine, ["whatsapp"]))), []);
});

test("the action reports every refusal it used to swallow", () => {
  const action = src("src/app/actions/flow.ts");
  const publish = action.slice(action.indexOf("export async function setActiveFlow"));
  assert.doesNotMatch(publish, /\.catch\(\(\) => null\)/);
  assert.match(publish, /FlowPublishValidationError/);
  assert.match(publish, /issues: error\.issues/);
  assert.match(publish, /FLOW_CHANGED_DURING_PUBLISH/);
  assert.match(publish, /nothing was published/i);
  assert.match(publish, /ok: `Published as version/);
});

test("the publish review surfaces refusals and prevents duplicate publication", () => {
  const button = src("src/components/PublishFlowButton.tsx");
  assert.match(button, /const \[pending, startTransition\] = useTransition\(\)/);
  assert.match(button, /const state = await setActiveFlow\(flowId, \{\}\)/);
  assert.match(button, /toast\.error\(state\.error\)/);
  assert.match(button, /toast\.success\(state\.ok \?\? "Flow published"\)/);
  assert.match(button, /if \(pending\) return/);
  assert.match(button, /disabled=\{pending\}/);
  assert.match(button, /Review before publishing/);

  const page = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(page, /<PublishFlowButton flowId=\{f\.id\}/);
  assert.doesNotMatch(page, /action=\{setActiveFlow\.bind/);
});
