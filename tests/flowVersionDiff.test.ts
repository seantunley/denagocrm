import assert from "node:assert/strict";
import { test } from "node:test";
import type { Flow } from "../src/lib/flow";
import { diffFlowVersions, nodeLabel, noDifferences } from "../src/lib/flowVersionDiff";

// Review 2026-11-02 (Sean's item 7): what changed between versions, and what a restore would do — in words.
const v1: Flow = {
  start: "menu",
  nodes: {
    menu: { id: "menu", type: "choice", text: "What do you need?", options: [{ id: "a", label: "Prices", next: "prices" }, { id: "b", label: "Brochure", next: "doc" }] },
    prices: { id: "prices", type: "message", text: "From R29,999.", next: "end" },
    doc: { id: "doc", type: "document", documentId: "d1", fileName: "Brochure.pdf", next: "end" },
    end: { id: "end", type: "end" },
  },
};
const v2: Flow = {
  start: "menu",
  nodes: {
    // Wording edited, option renamed, Brochure rewired to the new handoff.
    menu: { id: "menu", type: "choice", text: "Hi! What do you need?", options: [{ id: "a", label: "Our prices", next: "prices" }, { id: "b", label: "Brochure", next: "team" }] },
    prices: { id: "prices", type: "message", text: "From R29,999.", next: "end" },
    team: { id: "team", type: "handoff", text: "A person will help." },
    end: { id: "end", type: "end" },
  },
};
const json = (flow: Flow, extra: Record<string, unknown> = {}) => JSON.stringify({ ...flow, ...extra });

test("steps added, removed and edited — with which settings changed", () => {
  const diff = diffFlowVersions(json(v1), json(v2));
  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.added, ["A person will help."]);
  assert.deepEqual(diff.removed, ["Document: Brochure.pdf"]);
  assert.deepEqual(diff.changed, [{ label: "Hi! What do you need?", fields: ["wording", "choices"] }]);
  assert.equal(diff.startChanged, null);
});

test("connections made and broken are listed; a rewire alone is not an edit of the step", () => {
  const diff = diffFlowVersions(json(v1), json(v2));
  assert.deepEqual(diff.connectionsAdded, ["“Hi! What do you need?” on “Brochure” → “A person will help.”"]);
  assert.deepEqual(diff.connectionsRemoved, ["“What do you need?” on “Brochure” → “Document: Brochure.pdf”", "“Document: Brochure.pdf” → “End”"]);
  const rewired: Flow = { ...v1, nodes: { ...v1.nodes, prices: { id: "prices", type: "message", text: "From R29,999.", next: "doc" } } };
  const only = diffFlowVersions(json(v1), json(rewired));
  assert.deepEqual(only.changed, [], "moving a wire is a connection change, not a step edit");
  assert.equal(only.connectionsAdded.length, 1);
  assert.equal(only.connectionsRemoved.length, 1);
});

test("the same flow — or one only moved around the canvas — has no differences", () => {
  assert.ok(noDifferences(diffFlowVersions(json(v1), json(v1))));
  assert.ok(noDifferences(diffFlowVersions(json(v1), json(v1, { positions: { menu: { x: 900, y: 40 } } }))), "layout is not a change");
});

test("a new start step, and unreadable versions, are said plainly", () => {
  const moved = diffFlowVersions(json(v1), json({ ...v1, start: "prices" }));
  assert.deepEqual(moved.startChanged, { from: "What do you need?", to: "From R29,999." });
  assert.equal(diffFlowVersions("not json", json(v1)).comparable, false);
});

test("every step type has a name — none fall through to “End” any more", () => {
  assert.equal(nodeLabel({ id: "h", type: "http", method: "GET", url: "https://api.example.com/x" }, "h"), "API request: GET https://api.example.com/x");
  assert.equal(nodeLabel({ id: "s", type: "set", variable: "tier", value: "gold" }, "s"), "Save tier");
  assert.equal(nodeLabel({ id: "e", type: "end" }, "e"), "End");
});
