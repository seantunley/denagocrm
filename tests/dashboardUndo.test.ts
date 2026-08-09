import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Source with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PROVIDER = "src/components/dashboard/editor/EditorProvider.tsx";
const ROOT = "src/components/dashboard/editor/DashboardEditorRoot.tsx";

/**
 * UNDO.
 *
 * The editor could drag, resize and delete a card, and had no way back from any
 * of them. Saving is immediate and debounced by design — there is no Save button
 * to not press — so an accidental delete was already written by the time anyone
 * noticed, and rebuilding a card someone spent ten minutes configuring is how
 * people learn not to experiment with their own dashboard.
 *
 * These are source contracts: the provider is a client component built on React
 * hooks and cannot be exercised in a plain node test process. What can be pinned
 * is the handful of decisions that make undo correct rather than merely present.
 */

test("history is recorded in the one place every edit funnels through", () => {
  // Every mutation goes through `update`. Recording there is what makes it
  // impossible to add a new operation that silently is not undoable.
  const provider = code(PROVIDER);
  const fn = provider.slice(provider.indexOf("const update = useCallback"));
  const body = fn.slice(0, fn.indexOf("[persist]"));
  assert.match(body, /history\.current = \[\.\.\.history\.current, current\]/);
});

test("a refused edit is not recorded", () => {
  // parseConfigStrict rejects it and the config never changed, so undoing past
  // it would step over a state the user never saw.
  const provider = code(PROVIDER);
  const fn = provider.slice(provider.indexOf("const update = useCallback"));
  const body = fn.slice(0, fn.indexOf("[persist]"));
  const rejectAt = body.indexOf("return current;");
  const recordAt = body.indexOf("history.current = [");
  assert.ok(rejectAt !== -1 && recordAt !== -1);
  assert.ok(rejectAt < recordAt, "the invalid-config early return must come first");
});

test("history is bounded", () => {
  // A long editing session must not accumulate configs without limit.
  const provider = code(PROVIDER);
  assert.match(provider, /const UNDO_LIMIT = \d+;/);
  assert.match(provider, /\.slice\(-UNDO_LIMIT\)/);
});

test("undo does not record itself as a change", () => {
  // Going through `update` would push the undo onto the stack, so the first undo
  // would become something to undo and the stack could never empty.
  const provider = code(PROVIDER);
  const fn = provider.slice(provider.indexOf("const undo = useCallback"));
  const body = fn.slice(0, fn.indexOf("[persist]"));
  assert.doesNotMatch(body, /\bupdate\(/, "undo must not go through update()");
  assert.match(body, /setConfig\(previous\)/, "…it applies the previous config directly");
  assert.match(body, /persist\(previous\)/, "…and still saves, like every other edit");
});

test("undo on an empty history is a no-op, not a crash", () => {
  const provider = code(PROVIDER);
  const fn = provider.slice(provider.indexOf("const undo = useCallback"));
  const body = fn.slice(0, fn.indexOf("[persist]"));
  assert.match(body, /if \(!previous\) return;/);
});

test("a config arriving from the server clears the history", () => {
  // Undoing into arrangements from before a server re-seed would resurrect state
  // the server has already replaced.
  const provider = code(PROVIDER);
  const fn = provider.slice(provider.indexOf("seenSeed.current = seed;"));
  const body = fn.slice(0, fn.indexOf("}, [seed]"));
  assert.match(body, /history\.current = \[\]/);
  assert.match(body, /setUndoDepth\(0\)/, "the control must disable itself again too");
});

test("the control disables itself when there is nothing to undo", () => {
  const provider = code(PROVIDER);
  assert.match(provider, /canUndo: undoDepth > 0/);
  const rootSource = code(ROOT);
  assert.match(rootSource, /disabled=\{!canUndo\}/);
});

test("the keyboard shortcut does not hijack undo inside a text field", () => {
  // Inside an input, Ctrl+Z means "undo my typing". Reverting the whole card
  // instead would be worse than not offering the shortcut at all.
  const rootSource = code(ROOT);
  const fn = rootSource.slice(rootSource.indexOf("const onKey ="));
  const body = fn.slice(0, fn.indexOf("window.addEventListener"));
  assert.match(body, /INPUT/);
  assert.match(body, /TEXTAREA/);
  assert.match(body, /isContentEditable/);
});

test("the shortcut is bound only while editing", () => {
  // Otherwise it would swallow the browser's own undo on a page where there is
  // nothing of ours to undo.
  const rootSource = code(ROOT);
  const fn = rootSource.slice(rootSource.indexOf("useEffect(() => {"));
  assert.match(fn.slice(0, 200), /if \(!editing \|\| !canEdit\) return;/);
});

test("shift+ctrl+z is left alone", () => {
  // That is redo by convention, and redo does not exist yet. Treating it as undo
  // would do the opposite of what the person pressing it expects.
  const rootSource = code(ROOT);
  const fn = rootSource.slice(rootSource.indexOf("const onKey ="));
  assert.match(fn.slice(0, 600), /if \(event\.shiftKey\) return;/);
});
