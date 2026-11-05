import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { AI_NODE_SPECS, aiDraftIssues, aiNodeGuide, withAiRefLabels, type FlowAiRefs } from "../src/lib/flowAiNodes";
import type { Flow, FlowNode } from "../src/lib/flow";

const refs: FlowAiRefs = {
  journeys: [{ id: "j1", name: "Follow up" }],
  flows: [{ id: "f2", name: "Service menu" }],
  staff: [{ id: "u1", name: "Sales person" }],
  stages: [{ id: "s1", name: "Sales · Quoted" }],
  documents: [{ id: "d1", name: "Brochure.pdf" }],
  connections: [{ id: "c1", name: "Stock API", host: "api.example.com" }],
  tags: ["hot"],
};
const flowOf = (...nodes: FlowNode[]): Flow => ({ start: nodes[0].id, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) });
const codes = (flow: Flow, previous: Flow | null = null) => aiDraftIssues(flow, previous, refs).map((i) => i.code);

test("the AI designer knows every step the builder can make, except canvas notes", () => {
  // The engine's step types, read from its own union: a new one must get an AI_NODE_SPECS entry (tsc enforces it too).
  const union = readFileSync("src/lib/flow.ts", "utf8").split("export type FlowNode = (")[1].split(") & {")[0];
  const engineTypes = [...union.matchAll(/type: "([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(AI_NODE_SPECS).sort(), engineTypes);
  const guide = aiNodeGuide();
  for (const type of engineTypes) {
    if (type === "note" || type === "group") assert.doesNotMatch(guide, new RegExp(`^- ${type}:`, "m"));
    else assert.match(guide, new RegExp(`^- ${type}: `, "m"), `${type} missing from the AI's step list`);
  }
});

test("steps pointing at records the workspace has are accepted", () => {
  const flow = flowOf(
    { id: "a", type: "notify", userId: "u1", text: "Hot lead", next: "b" },
    { id: "b", type: "crm", action: "stage", stageId: "s1", next: "c", failureNext: "e" },
    { id: "c", type: "document", documentId: "d1", next: "d" },
    { id: "d", type: "http", method: "GET", url: "https://api.example.com/stock/{{model}}", connectionId: "c1", next: "g", failureNext: "e" },
    { id: "g", type: "subflow", flowId: "f2", next: "e", failureNext: "e" },
    { id: "e", type: "end" },
  );
  assert.deepEqual(codes(flow), []);
  const labelled = withAiRefLabels(flow, refs);
  assert.equal((labelled.nodes.a as Extract<FlowNode, { type: "notify" }>).userLabel, "Sales person");
  assert.equal((labelled.nodes.d as Extract<FlowNode, { type: "http" }>).connectionName, "Stock API");
});

test("invented ids, an http call outside a saved connection, and canvas notes are refused", () => {
  assert.deepEqual(codes(flowOf({ id: "a", type: "notify", userId: "someone-else", text: "x" })), ["ai.staff"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "crm", action: "assign", userId: "nobody" })), ["ai.staff"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "crm", action: "stage", stageId: "made-up" })), ["ai.stage"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "document", documentId: "d9" })), ["ai.document"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "subflow", flowId: "f9" })), ["ai.subflow"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "http", method: "POST", url: "https://evil.example.net/x" })), ["ai.http_connection"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "http", method: "GET", url: "https://evil.example.net/x", connectionId: "c1" })), ["ai.http_host"]);
  assert.deepEqual(codes(flowOf({ id: "a", type: "note", text: "hi" })), ["ai.type"]);
});

test("a step the owner built, carried over unchanged, is left alone", () => {
  const owners = flowOf({ id: "a", type: "http", method: "GET", url: "https://partner.example.org/ping" }, { id: "n", type: "note", text: "ask Sean" });
  assert.deepEqual(codes(structuredClone(owners), owners), []);
  const edited = structuredClone(owners);
  (edited.nodes.a as Extract<FlowNode, { type: "http" }>).url = "https://partner.example.org/other";
  assert.deepEqual(codes(edited, owners), ["ai.http_connection"], "once the AI changes it, the rules apply");
});
