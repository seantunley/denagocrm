import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dialogVisible, initialDialogNavState, nextDialogNavState, type DialogNavState } from "../src/components/ui/dialogNavigation";

/** Feed a sequence of (open, pathname) renders through the rules; return visibility after each. */
function run(steps: [boolean, string][]): boolean[] {
  let s: DialogNavState = initialDialogNavState(steps[0][0], steps[0][1]);
  return steps.map(([open, path]) => {
    s = nextDialogNavState(s, open, path);
    return dialogVisible(s, open);
  });
}

test("navigating away hides an open dialog", () => {
  assert.deepEqual(run([[true, "/quotes"], [true, "/signatures"]]), [true, false]);
});

test("REVIEW #688: coming back to the original pathname does NOT reopen it while the owner's open stays true", () => {
  // open on /a → navigate to /b (hidden) → back to /a with parent open still true → must stay hidden
  assert.deepEqual(run([[true, "/a"], [true, "/b"], [true, "/a"]]), [true, false, false]);
});

test("only a real reopen (open false → true) shows it again, on the new page", () => {
  assert.deepEqual(run([[true, "/a"], [true, "/b"], [false, "/b"], [true, "/b"]]), [true, false, false, true]);
});

test("query-only changes are the same pathname and keep it open", () => {
  // usePathname excludes the query string, so ?edit= / ?tab= never reach here as a change.
  assert.deepEqual(run([[true, "/quotes"], [true, "/quotes"]]), [true, true]);
});

test("uncontrolled dialogs are covered: held and closed by the wrapper", () => {
  const src = readFileSync("src/components/ui/dialog.tsx", "utf8");
  assert.match(src, /const open = controlled \? Boolean\(openProp\) : internalOpen/);
  assert.match(src, /if \(!controlled && next\.dismissed\) setInternalOpen\(false\)/);
  assert.match(src, /open=\{dialogVisible\(next, open\)\}/);
});
