import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_RESPONSIBILITY_HOURS } from "../src/lib/botOwnership";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Every `expiresAt: new Date(Date.now() + N * 3600 * 1000)` in a file. */
function sessionWindows(file: string): string[] {
  return [...src(file).matchAll(/expiresAt: new Date\(Date\.now\(\) \+ ([^)]+?) \* 3600 \* 1000\)/g)]
    .map((match) => match[1].trim());
}

test("an unclaimed handoff is held as long as a claimed takeover", () => {
  // These are the same commitment at two moments: the bot has stopped answering
  // and a person is expected to. A shorter window for the unclaimed one is what
  // dropped it out of the handoff queue before anybody had answered it.
  for (const file of ["src/lib/flowRun.ts", "src/lib/flowSession.ts"]) {
    const handoff = src(file).match(/ownership: "ai_handoff", expiresAt: new Date\(Date\.now\(\) \+ ([^)]+?) \* 3600 \* 1000\)/);
    assert.ok(handoff, `${file} must write a handoff session with an explicit window`);
    assert.equal(
      handoff[1].trim(),
      "HUMAN_RESPONSIBILITY_HOURS",
      `${file} must hold a handoff for the human-responsibility window, not a local literal`,
    );
  }
  assert.match(
    src("src/lib/botConversationControl.ts"),
    /hours = HUMAN_RESPONSIBILITY_HOURS/,
    "a staff takeover must use the same window, so the two cannot drift apart again",
  );
});

test("a conversation waiting for a person outlives one the bot still owns", () => {
  // The inversion this replaces: a handoff expired in 6h while an ordinary
  // in-progress bot session lasted 12-24h, so the conversation that needed
  // attention was the first to disappear.
  const botWindows = [...sessionWindows("src/lib/flowRun.ts"), ...sessionWindows("src/lib/flowSession.ts")]
    .filter((window) => window !== "HUMAN_RESPONSIBILITY_HOURS")
    .map(Number);
  assert.ok(botWindows.length, "expected at least one bot-owned session window to compare against");
  for (const hours of botWindows) {
    assert.ok(Number.isFinite(hours), "bot-owned session windows are plain hour literals");
    assert.ok(
      HUMAN_RESPONSIBILITY_HOURS > hours,
      `a handoff (${HUMAN_RESPONSIBILITY_HOURS}h) must outlive a bot-owned session (${hours}h)`,
    );
  }
});

test("the handoff queue and the runtime agree on when a handoff is gone", () => {
  // The queue filters on expiresAt, so the window above is also what decides how
  // long an unanswered handoff stays visible to staff.
  assert.match(
    src("src/lib/inboxCollaboration.ts"),
    /expiresAt: \{ gt: new Date\(\) \}/,
    "the queue must keep excluding sessions the runtime has already discarded",
  );
  // And the customer is never stuck waiting: this is the escape hatch that makes
  // holding the conversation open for a week safe.
  assert.match(
    src("src/lib/botOwnership.ts"),
    /if \(ownership === "ai_handoff"\)[\s\S]*?RESUME_COMMAND\.test\(text\)/,
    "a customer must still be able to release the bot themselves during a handoff",
  );
});
