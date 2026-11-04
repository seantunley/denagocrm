import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { FlowNode } from "../src/lib/flow";
import { searchFlow } from "../src/lib/flowSearch";

// Node-RED's search (Sean, 2026-11-04): type "brochure", jump to the step.
const nodes: Record<string, FlowNode> = {
  menu: { id: "menu", type: "choice", text: "What can we help with?", options: [{ id: "o1", label: "Get the brochure", next: "doc" }, { id: "o2", label: "Prices", next: "prices" }] },
  doc: { id: "doc", type: "document", documentId: "brochure-doc-id", fileName: "Rover XL brochure.pdf", caption: "Here you go", next: "end" },
  prices: { id: "prices", type: "message", text: "Prices start at R29,999 for the Rover.", next: "end" },
  note: { id: "note", type: "note", text: "Update the BROCHURE each quarter" },
  end: { id: "end", type: "end" },
};

test("finds every step that mentions it — buttons, file names, notes — whatever the case", () => {
  const hits = searchFlow(nodes, "brochure");
  assert.deepEqual(hits.map((h) => h.nodeId), ["menu", "doc", "note"]);
  assert.match(hits[0].snippet, /Get the brochure/);
  assert.match(hits[2].snippet, /BROCHURE/);
});

test("wiring and ids are not text: a step is not found by what it connects to", () => {
  assert.deepEqual(searchFlow(nodes, "prices").map((h) => h.nodeId), ["menu", "prices"], "the button label and the step itself, not the wire");
  assert.deepEqual(searchFlow(nodes, "brochure-doc-id"), [], "a document id is not something the owner typed");
});

test("a price, a long message, nothing typed", () => {
  const [hit] = searchFlow(nodes, "29,999");
  assert.equal(hit.nodeId, "prices");
  assert.match(hit.snippet, /R29,999/);
  assert.deepEqual(searchFlow(nodes, "   "), []);
});

test("the builder opens it from a button and Ctrl+F, and a result selects and zooms to the step", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /searchFlow\(/);
  assert.match(builder, /event\.key\.toLowerCase\(\) !== "f"\) return;\s*event\.preventDefault\(\);\s*setFindOpen\(true\);/);
  assert.match(builder, /const jumpTo = \(nodeId: string\) => \{ setSelectedId\(nodeId\); setInspectorOpen\(true\); window\.setTimeout\(\(\) => focusCanvasNode\.current\(nodeId\), 0\); \};/);
});
