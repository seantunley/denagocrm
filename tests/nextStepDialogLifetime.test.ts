import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Source with comments stripped, so an assertion cannot be satisfied by prose. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * THE BUG THIS COVERS.
 *
 * The ✓ on an agenda item marks an activity done. When that leaves its lead with
 * no planned next step, a dialog opens asking what happens next. It popped up
 * and vanished immediately.
 *
 * completeActivityAssess called revalidatePath("/") BEFORE it had even worked
 * out whether a next step was needed. Revalidating "/" rebuilds the agenda
 * without the activity just completed — which unmounts the row, and the state
 * holding the dialog open lives in CompleteActivityButton INSIDE that row. The
 * setState that opened the dialog and the revalidation that destroyed it were in
 * the same transition, so it painted for a frame and went.
 *
 * The rule: do not refresh a list while a dialog owned by one of its rows is
 * about to open. The refresh is deferred to the dialog's onClose instead.
 */

test("the completion action works out needsNextStep BEFORE it revalidates", () => {
  const actions = code("src/app/actions/activities.ts");
  const fn = actions.slice(actions.indexOf("export async function completeActivityAssess("));
  const body = fn.slice(0, fn.indexOf("export async function", 10));

  const decidedAt = body.indexOf("needsNextStep =");
  const revalidatedAt = body.indexOf("revalidateActivityViews()");
  assert.ok(decidedAt !== -1, "needsNextStep must still be computed here");
  assert.ok(revalidatedAt !== -1, "the refresh must still happen on the no-next-step path");
  assert.ok(
    decidedAt < revalidatedAt,
    "revalidating before deciding is the bug: it unmounts the row that is about to open a dialog",
  );
});

test("the completion action does NOT revalidate when a next step is needed", () => {
  const actions = code("src/app/actions/activities.ts");
  const fn = actions.slice(actions.indexOf("export async function completeActivityAssess("));
  const body = fn.slice(0, fn.indexOf("export async function", 10));
  assert.match(
    body,
    /if\s*\(\s*!needsNextStep\s*\)\s*revalidateActivityViews\(\)/,
    "the refresh must be conditional — this is the whole fix",
  );
  // A bare revalidatePath left behind in this function would reintroduce it.
  assert.doesNotMatch(
    body,
    /revalidatePath\(/,
    "no unconditional revalidatePath may remain in completeActivityAssess",
  );
});

test("the deferred refresh exists and is guarded", () => {
  const actions = code("src/app/actions/activities.ts");
  assert.match(actions, /export async function refreshAfterNextStep/);
  const fn = actions.slice(actions.indexOf("export async function refreshAfterNextStep"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  // A server action reachable by direct POST needs a session like any other,
  // even when all it does is invalidate a cache.
  assert.match(body, /requireUser\(\)/, "an exported server action must authenticate");
  assert.match(body, /revalidateActivityViews\(\)/);
});

test("both dialog call sites refresh when the dialog closes", () => {
  // Two components open this dialog — the agenda tick and the nudge flow. A fix
  // applied to one would leave the other showing a stale agenda.
  const component = code("src/components/proactive/NextStep.tsx");
  const closers = component.match(/onClose=\{\(\) => \{/g) ?? [];
  assert.equal(closers.length, 2, "both call sites must use the refreshing onClose");
  const refreshes = component.match(/refreshAfterNextStep\(\)/g) ?? [];
  assert.equal(refreshes.length, 2, "…and each must actually call it");
  // The old one-liner must be gone from both.
  assert.doesNotMatch(component, /onClose=\{\(\) => setNextStep\(null\)\}/);
});

test("the refresh runs on dismissal too, not only on completion", () => {
  // The activity is already done by the time the dialog opens. Dismissing the
  // next-step question does not undo that, so the agenda is stale either way.
  const component = code("src/components/proactive/NextStep.tsx");
  for (const block of component.split("onClose={() => {").slice(1)) {
    const handler = block.slice(0, block.indexOf("}}"));
    assert.match(handler, /setNextStep\(null\)/);
    assert.match(handler, /refreshAfterNextStep\(\)/);
    assert.doesNotMatch(handler, /if\s*\(/, "the refresh must not be conditional on how it closed");
  }
});
