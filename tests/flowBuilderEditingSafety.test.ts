import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = readFileSync(path.join(root, "src/components/FlowBuilder.tsx"), "utf8");

test("flow history supports undo and redo without hijacking text editing", () => {
  assert.match(builder, /const undo = useCallback/);
  assert.match(builder, /const redo = useCallback/);
  assert.match(builder, /history\.current\.future\.push/);
  assert.match(builder, /history\.current\.past\.push/);
  assert.match(builder, /target instanceof HTMLInputElement/);
  assert.match(builder, /target instanceof HTMLTextAreaElement/);
  assert.match(builder, /event\.shiftKey/);
  assert.match(builder, /HISTORY_LIMIT = 50/, "history must remain bounded");
});

test("a node drag is recorded as one graph edit and its position becomes dirty", () => {
  assert.match(builder, /onNodeDragStart=\{\(_, node\) => remember\(`drag:\$\{node\.id\}`, true\)\}/);
  assert.match(builder, /change\.type === "position" && !change\.dragging/);
  assert.match(builder, /markDirty\(\)/);
});

test("autosave uses the same optimistic concurrency fence as manual save", () => {
  assert.match(builder, /AUTOSAVE_DELAY_MS = 1_200/);
  assert.match(builder, /saveFlow\(flowId, definition, savedAt\.current\)/);
  assert.match(builder, /savedAt\.current = res\.updatedAt/);
  assert.match(builder, /blockedByConflict\.current = Boolean\(res\.conflict\)/);
  assert.match(builder, /if \(blockedByConflict\.current && !manual\) return/);
  assert.match(builder, /setTimeout\(\(\) => void persistDraft\(false\), AUTOSAVE_DELAY_MS\)/);
});

test("unsaved browser recovery is accepted only for the exact server revision", () => {
  assert.match(builder, /denagocrm:bot-flow-draft/);
  assert.match(builder, /stored\.baseUpdatedAt !== updatedAt/);
  assert.match(builder, /parsed\.nodes\?\.\[parsed\.start\]/);
  assert.match(builder, /Recovered unsaved flow changes from this browser/);
  assert.match(builder, /localStorage\.removeItem\(flowStorageKey\(flowId\)\)/);
});

test("internal links and document unloads both protect unsaved work", () => {
  assert.match(builder, /addEventListener\("beforeunload"/);
  assert.match(builder, /document\.addEventListener\("click", guardLink, true\)/);
  assert.match(builder, /closest\("a\[href\]"\)/);
  assert.match(builder, /Leave and discard them\?/);
  assert.match(builder, /event\.stopImmediatePropagation\(\)/);
  assert.match(builder, /document\.removeEventListener\("click", guardLink, true\)/);
});
