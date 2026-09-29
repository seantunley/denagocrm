import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/components/FlowBuilder.tsx"), "utf8");

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
  assert.match(source, /<button key=\{type\} type="button" draggable onDragStart=\{\(event\) => onPaletteDragStart\(event, type\)\}/);
  assert.match(source, /event\.dataTransfer\.setData\("application\/x-flowbot-node", type\)/);
  assert.match(source, /flowInstance\.current\.screenToFlowPosition/);
  assert.match(source, /\{ snapToGrid: true \}/);
  assert.match(source, /snapToGrid[\s\S]*snapGrid=\{\[GRID_SIZE, GRID_SIZE\]\}/);
});

test("Flowbot canvas exposes navigation aids and preserves dark React Flow controls", () => {
  // The MiniMap was removed at Sean's request (2026-09-01) — it read as clutter
  // in the corner of the canvas. Pinned ABSENT so a library upgrade or a copied
  // example does not quietly bring it back.
  assert.doesNotMatch(source, /<MiniMap/);
  assert.match(source, /<Controls\s+showInteractive=\{false\}/);
  /*
   * These asserted the selector that DOES NOT WORK, and so defended the bug.
   *
   * Tailwind turns underscores inside an arbitrary value into spaces, so the
   * class this used to require compiled to a descendant of `.react-flow` with an
   * element type that does not exist — a rule matching nothing, and four white
   * buttons on the dark canvas. Asserting `source.includes(...)` could never
   * catch that: it proves the string was typed, never that it styles anything.
   *
   * `[&_button]` has no underscores to mangle. Verified in the emitted CSS
   * (`.\[\&_button\]\:\!bg-\[\#18201d\] button`), not in the source.
   *
   * The intent of this test — dark controls, not white ones — is unchanged and
   * is now actually enforced. The stronger guard, which fails on ANY arbitrary
   * variant containing an unescaped `__`, lives in tests/darkThemeControls.
   */
  assert.ok(source.includes("[&_button]:!border-white/10"));
  assert.ok(source.includes("[&_button]:!bg-[#18201d]"));
  assert.ok(source.includes("[&_button]:!text-white"));
  assert.ok(source.includes("[&_button:hover]:!bg-white/10"));
  assert.ok(source.includes("[&_button_svg]:!fill-current"));
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