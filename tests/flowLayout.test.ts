import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Flow } from "../src/lib/flow";
import { TIDY_COLUMN, TIDY_ROW, tidyPositions } from "../src/lib/flowLayout";

// Node-RED's arrange (Sean, 2026-11-04): one button lines the steps up.
const flow: Flow = {
  start: "hi",
  nodes: {
    hi: { id: "hi", type: "message", text: "Hi", next: "menu" },
    menu: { id: "menu", type: "choice", text: "Pick", options: [{ id: "a", label: "Prices", next: "prices" }, { id: "b", label: "Team", next: "team" }] },
    prices: { id: "prices", type: "message", text: "R29,999", next: "back" },
    back: { id: "back", type: "goto", target: "menu" },
    team: { id: "team", type: "handoff", text: "Passing you on" },
    orphan: { id: "orphan", type: "message", text: "Nothing leads here" },
    note: { id: "note", type: "note", text: "Update prices quarterly" },
  },
};

test("left to right in conversation order; buttons top to bottom; a loop back doesn't move the menu", () => {
  const p = tidyPositions(flow, { x: 0, y: 0 });
  assert.deepEqual(p.hi, { x: 0, y: 0 });
  assert.deepEqual(p.menu, { x: TIDY_COLUMN, y: 0 });
  assert.deepEqual(p.prices, { x: 2 * TIDY_COLUMN, y: 0 }, "first button first");
  assert.deepEqual(p.team, { x: 2 * TIDY_COLUMN, y: TIDY_ROW });
  assert.deepEqual(p.back, { x: 3 * TIDY_COLUMN, y: 0 }, "the Go to back to the menu sits after prices, the menu stays put");
});

test("steps nothing leads to go in a last column; notes and groups are left where they are", () => {
  const p = tidyPositions(flow, { x: 0, y: 0 });
  assert.deepEqual(p.orphan, { x: 4 * TIDY_COLUMN, y: 0 });
  assert.equal(p.note, undefined);
});

test("the builder's Tidy button is one undoable change, then shows the whole flow", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /remember\("tidy", true\);/);
  assert.match(builder, /const positions = tidyPositions\(currentFlow\);/);
});
