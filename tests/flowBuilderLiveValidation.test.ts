import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (file: string) => readFileSync(path.join(root, file), "utf8");

test("the editor validates the current graph rather than only the saved server draft", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /const currentFlow = useMemo/);
  assert.match(builder, /Object\.fromEntries\(rfNodes\.map/);
  assert.match(builder, /validateFlow\(currentFlow, channels\)/);
  assert.match(builder, /<FlowLintPanel issues=\{liveIssues\}/);
  assert.match(src("src/app/(app)/bot-builder/[id]/page.tsx"), /channels=\{channels\}/);
});

test("live issues are grouped onto their affected canvas cards", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /issuesByNode/);
  assert.match(builder, /issues: issuesByNode\.get\(node\.id\) \?\? \[\]/);
  assert.match(builder, /errors \? "border-red-400\/80/);
  assert.match(builder, /warnings \? "border-amber-400\/70/);
  assert.match(builder, /Checks for this node/);
});

test("selecting a compiler issue focuses the node and opens its inspector", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /const focusIssue = useCallback/);
  assert.match(builder, /setSelectedId\(issue\.nodeId\)/);
  assert.match(builder, /setInspectorOpen\(true\)/);
  assert.match(builder, /instance\.fitView/);

  const panel = src("src/components/FlowLintPanel.tsx");
  assert.match(panel, /onSelectIssue\?\.\(item\)/);
  assert.match(panel, /Show node →/);
});

test("the saved-draft-only lint panel is no longer rendered above the editor", () => {
  const page = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.doesNotMatch(page, /const issues = validateFlow/);
  assert.doesNotMatch(page, /<FlowLintPanel/);
});
