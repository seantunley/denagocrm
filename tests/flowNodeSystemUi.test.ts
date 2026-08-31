import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function quotedLabels(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return [...source.slice(from, to).matchAll(/label:\s*"([^"]+)"/g)].map((match) => match[1]);
}

test("node system groups every existing node label without taxonomy drift", () => {
  const frame = src("src/components/FlowNodeSystemFrame.tsx");
  const builder = src("src/components/FlowBuilder.tsx");

  for (const group of ["Messages", "Customer input", "Logic & data", "AI & operations"]) assert.match(frame, new RegExp(group));

  const guideLabels = quotedLabels(frame, "const groups", "const routeLegend").filter((label) => !["Messages", "Customer input", "Logic & data", "AI & operations"].includes(label));
  const builderLabels = quotedLabels(builder, "const TYPE_META", "function summary");

  assert.deepEqual([...guideLabels].sort(), [...builderLabels].sort(), "the guide must cover exactly the node labels FlowBuilder renders");
  assert.equal(new Set(guideLabels).size, guideLabels.length, "a node label must appear in exactly one guide group");
});

test("node system route legend matches the existing outcome-coloured handles", () => {
  const frame = src("src/components/FlowNodeSystemFrame.tsx");
  const builder = src("src/components/FlowBuilder.tsx");

  for (const label of ["Success / Yes", "No", "If it fails", "Unavailable"]) assert.match(frame, new RegExp(label.replaceAll("/", "\\/")));
  assert.doesNotMatch(frame, /Failure \/ No|Handoff/);

  assert.match(builder, /#34d399/);
  assert.match(builder, /#f87171/);
  assert.match(builder, /#fbbf24/);
  assert.match(builder, /#94a3b8/);
  assert.doesNotMatch(frame, /saveFlow|runFlow|publishFlowSnapshot|prisma|migration/i);
});

test("node system strengthens selection, handles and keyboard-sized controls", () => {
  const frame = src("src/components/FlowNodeSystemFrame.tsx");
  assert.match(frame, /react-flow__node-flowNode\.selected/);
  assert.match(frame, /react-flow__edge\.selected/);
  assert.match(frame, /react-flow__handle/);
  assert.match(frame, /!size-3\.5/);
  assert.match(frame, /min-h-11/);
  assert.match(frame, /aria-expanded=\{guideOpen\}/);
  assert.match(frame, /aria-controls="flow-node-guide"/);
  assert.doesNotMatch(frame, /react-flow__node-flowNode>div\]:!w-64/);
});

test("Flow Builder is wrapped by the node-system frame", () => {
  const page = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.match(page, /import FlowNodeSystemFrame/);
  assert.match(page, /<FlowNodeSystemFrame>[\s\S]*<FlowBuilder[\s\S]*<\/FlowNodeSystemFrame>/);
  assert.match(page, /const scope = await flowScope\(\)/);
  assert.match(page, /findFirst\(\{ where: \{ id, \.\.\.scope \} \}\)/);
});