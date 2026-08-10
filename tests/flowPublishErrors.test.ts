import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { flowErrors, publishSeverity, validateFlow, type FlowIssue } from "../src/lib/flowValidation";
import type { Flow } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The compiler was right and the operator never heard it.
 *
 * The server validates strictly more than the editor can — a Journey disabled
 * since the draft was written, a draft that moved during publication, an action
 * whose failure route would announce success. `setActiveFlow` caught all of it
 * into null and returned, so a correct refusal reached the owner as a button that
 * did nothing at all: no audit, no revalidate, no error.
 */

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
  // The specific reason has to survive into the message, or the owner is no better
  // off than with silence.
  assert.ok(
    message.includes(errors[0].message),
    `the refusal must name the actual problem, got: ${message}`,
  );
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
  // The defect, precisely.
  assert.doesNotMatch(publish, /\.catch\(\(\) => null\)/, "a refusal must never become null");
  assert.match(publish, /FlowPublishValidationError/, "validation issues are surfaced");
  assert.match(publish, /issues: error\.issues/, "and passed through structured, not flattened away");
  // The two specific conditions worth their own words.
  assert.match(publish, /FLOW_CHANGED_DURING_PUBLISH/);
  assert.match(publish, /nothing was published/i, "the owner must know the draft is untouched");
  // Success has to be reported too, or the button still looks inert.
  assert.match(publish, /ok: `Published as version/);
});

test("the button renders the refusal instead of doing nothing", () => {
  const button = src("src/components/PublishFlowButton.tsx");
  assert.match(button, /useActionState\(setActiveFlow\.bind\(null, flowId\)/);
  assert.match(button, /toast\.error\(state\.error\)/);
  assert.match(button, /state\.ok/, "and confirms a successful publish");
  assert.match(button, /disabled=\{pending\}/, "publishing twice is not a fix for silence");

  // The page must actually use it — the old bare form is the bug.
  const page = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(page, /<PublishFlowButton flowId=\{f\.id\}/);
  assert.doesNotMatch(page, /action=\{setActiveFlow\.bind/, "the silent form must be gone");
});
