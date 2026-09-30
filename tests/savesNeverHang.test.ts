import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A save that throws must not leave its button on "Saving…" forever.
 *
 * The checklist editor, segment builder and signature pad each set a busy flag,
 * awaited a server action, and cleared the flag on the next line. When the call
 * never arrived (a tab left open across a deploy, a network blip, an expired
 * login) the await threw, the clear never ran, and the person saw "Saving…"
 * indefinitely with no message. Clearing it in `finally` is the fix, and the
 * cheapest proof a component has one is that the word is there at all.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

const BUSY = /set(Busy|Saving|Submitting|Counting)\(true\)/;
// Passkey login and the photo annotator clear the flag in `catch` and on
// navigation respectively; both were read and handle a throw.
const HANDLED_WITHOUT_FINALLY = new Set(["src/components/PasskeyLoginButton.tsx", "src/components/PhotoAnnotator.tsx"]);

test("every busy flag set around an await is cleared in a finally", () => {
  const offenders = files("src")
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => !HANDLED_WITHOUT_FINALLY.has(f))
    .filter((f) => {
      const text = readFileSync(f, "utf8");
      return BUSY.test(text) && /await /.test(text) && !/finally/.test(text);
    });
  assert.deepEqual(offenders, [], "set the flag false in a `finally`, or a thrown save hangs the button");
});

test("the app layout keeps an attended session alive and warns when it has lapsed", () => {
  assert.match(readFileSync("src/app/(app)/layout.tsx", "utf8"), /<SessionKeeper \/>/);
  const keeper = readFileSync("src/components/SessionKeeper.tsx", "utf8");
  assert.match(keeper, /fetch\("\/api\/session"/);
  assert.match(keeper, /visibilitychange/, "check on return to the tab, before the person presses Save");
  assert.match(keeper, /target="_blank"/, "sign in elsewhere so this page's typing survives");
});
