import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideInboundAct } from "../src/lib/botOwnership";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const act = (ownership: Parameters<typeof decideInboundAct>[0]["ownership"], text: string, hasChoiceId = false) =>
  decideInboundAct({ ownership, text, hasChoiceId }).act;

test("a staff-owned conversation cannot be taken back by anything the customer types", () => {
  // The actual sequence that broke: customer asks for a human, a salesperson
  // starts replying, customer says "hi", and the bot restarted the flow on top
  // of the person.
  for (const text of ["hi", "hello", "hey", "menu", "restart", "start over", "anything at all"]) {
    assert.equal(act("human", text), "suppress", `"${text}" must not wake the bot on a human-owned conversation`);
  }
});

test("a bot handoff is escaped only by an explicit command, never by a greeting", () => {
  for (const greeting of ["hi", "hello", "hey", "hi there", "Hey!"]) {
    assert.equal(act("ai_handoff", greeting), "suppress", `"${greeting}" is a greeting, not a control command`);
  }
  for (const command of ["menu", "restart", "start over", "start again", "MENU"]) {
    assert.equal(act("ai_handoff", command), "restart", `"${command}" must return the customer to the bot`);
  }
});

test("a tapped button never escapes a handoff", () => {
  // Option ids are attacker-free but they are also not a request to restart —
  // a stale keyboard from before the handoff must not resurrect the bot.
  assert.equal(act("ai_handoff", "", true), "suppress");
  assert.equal(act("ai_handoff", "menu", true), "suppress");
});

test("after a message definitively failed to send, the next one starts over", () => {
  // The customer never saw the prompt. Resuming would interpret their reply
  // against a menu that does not exist for them.
  assert.equal(act("delivery_failed", "I need some help"), "restart");
  assert.equal(act("delivery_failed", "Rover XL"), "restart");
  assert.equal(act("delivery_failed", "", true), "restart", "even a stale button must not resume the dead node");
});

test("a conversation the bot still owns behaves exactly as before", () => {
  // Deliberately unchanged: nobody else is holding it, so "hi" meaning "take me
  // back to the top" is harmless.
  for (const text of ["hi", "hello", "hey", "menu", "start", "begin", "restart"]) {
    assert.equal(act("bot", text), "restart", `"${text}" restarts a bot-owned conversation, as it always did`);
  }
  assert.equal(act("bot", "the blue one"), "resume");
  assert.equal(act("bot", "Rover XL", true), "resume", "a tapped option is answered, not treated as a command");
});

test("no session at all is a fresh run", () => {
  assert.equal(act(null, "hi"), "restart");
  assert.equal(act(null, "I want a service booking"), "restart");
});

test("the runtime asks this module rather than testing status directly", () => {
  // The defect was `existing?.status === "paused" && !restart`, which cannot tell
  // a bot handoff from a human takeover. If that shape comes back, so does the bug.
  const code = src("src/lib/flowSession.ts");
  assert.match(code, /decideInboundAct\(/, "advanceFlow must use the ownership decision");
  assert.doesNotMatch(
    code,
    /status === "paused" && !restart/,
    "suppression must not be decided by status alone — that is what conflated handoff with takeover",
  );
});
