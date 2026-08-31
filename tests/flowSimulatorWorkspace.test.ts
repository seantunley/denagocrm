import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(`${process.cwd()}/${path}`, "utf8");

test("simulator exposes QA scenario presets and explicit run states", async () => {
  const source = await read("src/components/FlowSimulator.tsx");
  assert.match(source, /SCENARIO_PRESETS/);
  assert.match(source, /Happy path/);
  assert.match(source, /AI handoff/);
  assert.match(source, /CRM failure/);
  assert.match(source, /Fully booked/);
  assert.match(source, /RunStatePill/);
  assert.match(source, /Handed off/);
  assert.match(source, /Completed/);
  assert.match(source, /Failed/);
});

test("simulator transcript records timestamps and keeps rerun visible", async () => {
  const source = await read("src/components/FlowSimulator.tsx");
  assert.match(source, /toLocaleTimeString/);
  assert.match(source, /Rerun/);
  assert.match(source, /Customer preview/);
  assert.match(source, /Execution trace/);
  assert.match(source, /Variables/);
});

test("execution pane can be resized on large screens", async () => {
  const source = await read("src/components/FlowSimulator.tsx");
  assert.match(source, /xl:resize-x/);
  assert.match(source, /xl:min-w-\[18rem\]/);
  assert.match(source, /xl:max-w-\[32rem\]/);
});

test("evaluation suite groups passed failed and not-run cases", async () => {
  const source = await read("src/app/(app)/bot-builder/[id]/evaluations/page.tsx");
  assert.match(source, /title="Failed"/);
  assert.match(source, /title="Not run"/);
  assert.match(source, /title="Passed"/);
  assert.match(source, /Expected/);
  assert.match(source, /Actual/);
});

test("run-all action remains the existing deterministic evaluation action", async () => {
  const source = await read("src/app/(app)/bot-builder/[id]/evaluations/page.tsx");
  assert.match(source, /runAllFlowEvaluations\.bind\(null, id\)/);
  assert.match(source, /Running \$\{evaluations\.length\} cases/);
});
