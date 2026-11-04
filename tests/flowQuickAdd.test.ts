import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rankStepTypes } from "../src/lib/flowQuickAdd";

// Node-RED's Ctrl+click quick-add (Sean, 2026-11-04).
const options = [
  { type: "message", label: "Message", description: "Send a text" },
  { type: "choice", label: "Menu", description: "Buttons the customer taps" },
  { type: "image", label: "Image", description: "Send a picture" },
  { type: "set", label: "Save a value", description: "Store a message variable" },
];

test("a label that starts with what was typed comes first, then one containing it, then a description", () => {
  assert.deepEqual(rankStepTypes("mess", options).map((o) => o.type), ["message", "set"], "Message by label, Save a value by its description");
  assert.deepEqual(rankStepTypes("me", options).map((o) => o.type), ["message", "choice", "set"]);
  assert.deepEqual(rankStepTypes("picture", options).map((o) => o.type), ["image"]);
  assert.deepEqual(rankStepTypes("zzz", options), []);
  assert.equal(rankStepTypes("", options).length, 4, "nothing typed: the list as it is");
});

test("Ctrl/⌘+click on empty canvas opens it; the step is added where you clicked", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /onPaneClick=\{\(event\) => \{ setSelectedId\(null\); if \(event\.ctrlKey \|\| event\.metaKey\) openQuickAdd\(event\); \}\}/);
  assert.match(builder, /screenToFlowPosition\(\{ x: event\.clientX, y: event\.clientY \}, \{ snapToGrid: true \}\);\s*setQuickAdd\(/);
  assert.match(builder, /addNode\(type, quickAdd\.at\);/);
});
