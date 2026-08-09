import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_FLOW, type Flow } from "../src/lib/flow";
import { flowErrors, flowVariables, validateFlow } from "../src/lib/flowValidation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("the shipped default flow compiles for every currently supported text channel", () => {
  const issues = validateFlow(DEFAULT_FLOW, ["whatsapp", "messenger", "instagram", "telegram"]);
  assert.deepEqual(flowErrors(issues), []);
});

test("publication rejects missing targets and automatic no-input loops", () => {
  const missing = copy(DEFAULT_FLOW);
  (missing.nodes.welcome as Extract<Flow["nodes"][string], { type: "choice" }>).options[0].next = "gone";
  assert.ok(flowErrors(validateFlow(missing)).some((item) => item.code === "graph.missing_target"));

  const loop: Flow = {
    start: "a",
    nodes: {
      a: { id: "a", type: "message", text: "A", next: "b" },
      b: { id: "b", type: "answer", text: "B", next: "a" },
    },
  };
  assert.ok(flowErrors(validateFlow(loop)).some((item) => item.code === "graph.automatic_cycle"));
});

test("conditions participate in graph reachability and automatic-loop safety", () => {
  const flow: Flow = {
    start: "gate",
    nodes: {
      gate: { id: "gate", type: "condition", condition: { variable: "channel", operator: "equals", value: "whatsapp" }, trueNext: "yes", falseNext: "no" },
      yes: { id: "yes", type: "message", text: "Yes", next: "end" },
      no: { id: "no", type: "message", text: "No", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  assert.deepEqual(flowErrors(validateFlow(flow)), []);

  flow.nodes.yes = { id: "yes", type: "message", text: "Again", next: "gate" };
  assert.ok(flowErrors(validateFlow(flow)).some((item) => item.code === "graph.automatic_cycle"));
});

test("condition variables are checked against built-ins and captured values", () => {
  const flow: Flow = {
    start: "capture",
    nodes: {
      capture: { id: "capture", type: "capture", text: "Which model?", variable: "model", next: "gate" },
      gate: { id: "gate", type: "condition", condition: { variable: "model", operator: "contains", value: "Rover" }, trueNext: "end", falseNext: "end" },
      end: { id: "end", type: "end" },
    },
  };
  assert.ok(flowVariables(flow).includes("model"));
  assert.ok(flowVariables(flow).includes("channel"));
  assert.ok(!validateFlow(flow).some((item) => item.code === "condition.unknown_variable"));

  (flow.nodes.gate as Extract<Flow["nodes"][string], { type: "condition" }>).condition.variable = "mystery";
  assert.ok(validateFlow(flow).some((item) => item.code === "condition.unknown_variable"));
});

test("unreachable nodes and unknown variables are warnings, not unsafe publication errors", () => {
  const flow = copy(DEFAULT_FLOW);
  flow.nodes.orphan = { id: "orphan", type: "message", text: "Hi {{missing_value}}" };
  const issues = validateFlow(flow);
  assert.ok(issues.some((item) => item.code === "graph.unreachable" && item.severity === "warning"));
  assert.ok(issues.some((item) => item.code === "variable.unknown" && item.severity === "warning"));
});

test("channel capability checks catch adapter truncation before publish", () => {
  const many: Flow = {
    start: "menu",
    nodes: {
      menu: {
        id: "menu",
        type: "choice",
        text: "Pick",
        options: Array.from({ length: 12 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}`, next: "end" })),
      },
      end: { id: "end", type: "end" },
    },
  };
  const issues = validateFlow(many, ["whatsapp", "messenger"]);
  assert.ok(issues.some((item) => item.code === "channel.whatsapp.options"));
  assert.ok(issues.some((item) => item.code === "channel.meta.options"));
});

test("file capture is blocked only on enabled channels that cannot resume it", () => {
  const flow: Flow = {
    start: "file",
    nodes: {
      file: { id: "file", type: "captureFile", text: "Send it", variable: "photo", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  assert.equal(flowErrors(validateFlow(flow, ["whatsapp"])).length, 0);
  const crossChannel = flowErrors(validateFlow(flow, ["whatsapp", "instagram", "telegram"]));
  assert.ok(crossChannel.some((item) => item.code === "channel.file_capture" && item.channel === "instagram"));
  assert.ok(crossChannel.some((item) => item.code === "channel.file_capture" && item.channel === "telegram"));
});

test("publish boundary compiles the exact definition before the immutable snapshot transaction", () => {
  const code = src("src/lib/flowPublishing.ts");
  const validateAt = code.indexOf("validateFlowForEnabledChannels(parsed)");
  const txAt = code.indexOf("return withTenantWrite", validateAt);
  assert.ok(validateAt >= 0 && txAt > validateAt);
  assert.match(code, /if \(flowErrors\(issues\)\.length\) throw new FlowPublishValidationError\(issues\)/);
  assert.match(code, /if \(flow\.definition !== draft\.definition\) throw new Error\("FLOW_CHANGED_DURING_PUBLISH"\)/);
});

test("flow library suppresses publish controls while compiler errors exist", () => {
  const page = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(page, /const blocked = check\.errors\.length > 0/);
  assert.match(page, /Publish blocked/);
  assert.match(page, /\(!f\.active \|\| pending\) && !blocked/);

  const editor = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.match(editor, /<FlowLintPanel issues=\{issues\} channels=\{channels\} \/>/);
});
