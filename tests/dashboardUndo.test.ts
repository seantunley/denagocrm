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

test("the echo of this editor's own save does NOT clear the history", () => {
  /*
   * The lifecycle bug that defeated the whole feature. Every successful save
   * calls revalidatePath("/"), so the server sends the config straight back. The
   * re-seed effect treated any changed seed as a foreign config and wiped the
   * history - roughly 600ms after every edit.
   *
   * So undo only covered the window BEFORE the autosave landed, which is the
   * opposite of why it exists: saving is immediate, so an accidental delete is
   * already persisted by the time anyone notices, and that was precisely the
   * state left with no history.
   */
  const provider = code(PROVIDER);
  const effect = provider.slice(provider.indexOf("seenSeed.current = seed;"));
  const body = effect.slice(0, effect.indexOf("}, [seed]"));

  assert.match(body, /ownSeeds\.current\.has\(seed\)/, "an echo of our own save must be recognised");
  assert.match(body, /if \(!isOwnEcho\)/, "only a foreign config may clear the history");

  const guardAt = body.indexOf("if (!isOwnEcho)");
  const clearAt = body.indexOf("history.current = []");
  assert.ok(guardAt !== -1 && clearAt !== -1, "both the guard and the clear must exist");
  assert.ok(guardAt < clearAt, "an unconditional clear defeats the feature");
});

test("a genuinely foreign config still clears the history", () => {
  // Undoing into arrangements from before someone else's change would resurrect
  // state the server has already discarded.
  const provider = code(PROVIDER);
  const effect = provider.slice(provider.indexOf("seenSeed.current = seed;"));
  const body = effect.slice(0, effect.indexOf("}, [seed]"));
  assert.match(body, /history\.current = \[\]/);
  assert.match(body, /setUndoDepth\(0\)/, "the control must disable itself again too");
});

test("a save records its seed so the echo can be recognised", () => {
  const provider = code(PROVIDER);
  const save = provider.slice(provider.indexOf("committed.current = next;"));
  const body = save.slice(0, save.indexOf("} catch"));
  assert.match(body, /ownSeeds\.current\.add\(/, "without this every echo looks foreign");
});

test("the own-seed set is bounded", () => {
  // An echo that never arrives would otherwise leave its key there forever.
  const provider = code(PROVIDER);
  assert.match(provider, /const OWN_SEED_LIMIT = \d+;/);
  assert.match(provider, /ownSeeds\.current\.size > OWN_SEED_LIMIT/);
});

test("a matched echo is consumed, so a later foreign config still clears", () => {
  // A stale entry could otherwise match a foreign config that happened to be
  // identical, and wrongly keep the history.
  const provider = code(PROVIDER);
  const effect = provider.slice(provider.indexOf("seenSeed.current = seed;"));
  const body = effect.slice(0, effect.indexOf("}, [seed]"));
  assert.match(body, /ownSeeds\.current\.delete\(seed\)/);
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
