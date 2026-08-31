import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/components/FlowBuilder.tsx", import.meta.url), "utf8");

test("Flowbot canvas has a searchable categorised node palette", () => {
  assert.match(source, /const NODE_GROUPS/);
  assert.match(source, /label: "Messages"/);
  assert.match(source, /label: "Customer input"/);
  assert.match(source, /label: "Logic & data"/);
  assert.match(source, /label: "AI & operations"/);
  assert.match(source, /placeholder="Search nodes…"/);
  assert.match(source, /aria-label="Search nodes"/);
});

test("Flowbot nodes can be dragged from the palette onto a snapped canvas", () => {
  assert.match(source, /draggable/);
  assert.match(source, /application\/x-flowbot-node/);
  assert.match(source, /screenToFlowPosition/);
  assert.match(source, /snapToGrid/);
  assert.match(source, /snapGrid=\{\[GRID_SIZE, GRID_SIZE\]\}/);
});

test("Flowbot canvas exposes navigation aids and onboarding", () => {
  assert.match(source, /<MiniMap pannable zoomable/);
  assert.match(source, /<Controls showInteractive=\{false\}/);
  assert.match(source, /Build your first conversation step/);
  assert.match(source, /Open node palette/);
});

test("semantic routes remain visible and selected routes are emphasised", () => {
  assert.match(source, /label: "Yes"/);
  assert.match(source, /label: "No"/);
  assert.match(source, /label: "handoff"/);
  assert.match(source, /label: "fails"/);
  assert.match(source, /label: "none available"/);
  assert.match(source, /connectedToSelection/);
  assert.match(source, /opacity: connectedToSelection \? 1 : 0\.32/);
});

test("large flows avoid animating every edge", () => {
  assert.match(source, /LARGE_FLOW_EDGE_ANIMATION_LIMIT = 40/);
  assert.match(source, /const animateAll = rfNodes\.length <= LARGE_FLOW_EDGE_ANIMATION_LIMIT/);
});

test("node quick actions include duplicate and set start without changing node semantics", () => {
  assert.match(source, /function duplicateNode/);
  assert.match(source, /title="Duplicate node"/);
  assert.match(source, /Set start/);
  assert.doesNotMatch(source, /prisma\./);
});
