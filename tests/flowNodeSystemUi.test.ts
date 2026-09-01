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

  // The guide's group headings. "CRM & automation" arrived with the advanced
  // nodes; every heading must be listed here, because the scrape below cannot
  // tell a group's label from a node's and filters headings out by name.
  const GUIDE_GROUPS = ["Messages", "Customer input", "Logic & data", "CRM & automation", "AI & operations"];
  for (const group of GUIDE_GROUPS) assert.match(frame, new RegExp(group.replace("&", "\\&")));

  const guideLabels = quotedLabels(frame, "const groups", "const routeLegend").filter((label) => !GUIDE_GROUPS.includes(label));
  /*
   * Scraped up to `const NODE_GROUPS`, not `function summary`.
   *
   * These markers bracket a region of source and pull every `label: "…"` out of
   * it, so the region has to contain node labels and NOTHING ELSE. The canvas
   * redesign added NODE_GROUPS — the palette's own category headings, each with a
   * `label:` — between TYPE_META and `summary`, and those four headings were
   * promptly read as four extra node types. The guide could never have listed
   * them, so this failed the moment the redesign landed, and `main` went red.
   *
   * The guide side has always coped with the same hazard by FILTERING the four
   * names out after the fact (just above). Moving the builder's end marker is the
   * same fix made structurally: TYPE_META ends exactly where NODE_GROUPS begins,
   * so the region now holds node labels only, whatever is appended after it.
   */
  const builderLabels = quotedLabels(builder, "const TYPE_META", "const NODE_GROUPS");

  assert.deepEqual([...guideLabels].sort(), [...builderLabels].sort(), "the guide must cover exactly the node labels FlowBuilder renders");
  assert.equal(new Set(guideLabels).size, guideLabels.length, "a node label must appear in exactly one guide group");
});

test("EVERY NODE TYPE SITS IN EXACTLY ONE PALETTE GROUP — none stranded, none twice", () => {
  /*
   * The invariant the drift above exposed. NODE_GROUPS is what the palette
   * renders, so a type missing from it is a node the builder still knows how to
   * draw but nobody can ADD — invisible, and invisible in a way no type error and
   * no render test would catch, because the node type is perfectly valid.
   *
   * Checked here rather than left to the label comparison, which comes at the
   * same question from the guide's side and would pass happily while a type sat
   * in no group at all.
   */
  const builder = src("src/components/FlowBuilder.tsx");
  const metaRegion = builder.slice(
    builder.indexOf("const TYPE_META"),
    builder.indexOf("const NODE_GROUPS"),
  );
  const groupRegion = builder.slice(
    builder.indexOf("const NODE_GROUPS"),
    builder.indexOf("function summary"),
  );

  const types = [...metaRegion.matchAll(/^\s{2}(\w+):\s*\{\s*icon:/gm)].map((match) => match[1]);
  const grouped = [...groupRegion.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => types.includes(value));

  assert.ok(types.length > 0, "no node types found — the TYPE_META scrape has drifted");
  assert.deepEqual(
    [...grouped].sort(),
    [...types].sort(),
    "every node type in TYPE_META must appear in exactly one NODE_GROUPS entry",
  );
  assert.equal(new Set(grouped).size, grouped.length, "a node type is in two palette groups");
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