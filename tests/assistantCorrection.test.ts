import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { correctedQuestion, looksLikeCorrection } from "../src/lib/assistantCorrection";
import { chatQueue, emptyChatQueue, type ChatQueue, type ChatQueueAction } from "../src/components/chatQueue";

const ACTIVE = "Compare the Rover XL and Scout 2 for an estate buyer";

test("a correction of the question being answered is offered; an independent one and thanks are not", () => {
  assert.equal(looksLikeCorrection("Actually, Scout 4", ACTIVE), true);
  assert.equal(looksLikeCorrection("Sorry, I meant the Scout 4", ACTIVE), true);
  assert.equal(looksLikeCorrection("make that the Scout 4", ACTIVE), true);
  assert.equal(looksLikeCorrection("Scout 4, not Scout 2", ACTIVE), true);
  assert.equal(looksLikeCorrection("Scout 4", ACTIVE), true, "a few words picking up the question");
  assert.equal(looksLikeCorrection("Use the Scout 4 instead", ACTIVE), true);

  assert.equal(looksLikeCorrection("Then check delivery to Paarl", ACTIVE), false, "a new instruction waits its turn");
  assert.equal(looksLikeCorrection("Also, has Anna paid?", ACTIVE), false);
  assert.equal(looksLikeCorrection("Thanks", ACTIVE), false);
  assert.equal(looksLikeCorrection("Actually, thanks", ACTIVE), false);
  assert.equal(looksLikeCorrection("No", ACTIVE), false, "nothing after the opening word");
  assert.equal(looksLikeCorrection("Why is the Paarl delivery not booked yet?", ACTIVE), false);
  assert.equal(looksLikeCorrection("Who has the most open quotes this month", ACTIVE), false);
  assert.equal(looksLikeCorrection(`Actually ${"x".repeat(130)}`, ACTIVE), false, "too long to be a quick fix");
});

test("the corrected question keeps the original and the correction — the correction is never cut off", () => {
  assert.equal(correctedQuestion(ACTIVE, "Actually, Scout 4"), `${ACTIVE}\n\nCorrection: Scout 4`);
  assert.equal(correctedQuestion(ACTIVE, "not Scout 2 but Scout 4"), `${ACTIVE}\n\nCorrection: not Scout 2 but Scout 4`, "meaning words stay");
  const long = correctedQuestion("q".repeat(600), "Actually, Scout 4");
  assert.ok(long.length <= 500, String(long.length));
  assert.ok(long.endsWith("Correction: Scout 4"));
});

const run = (...actions: ChatQueueAction<string>[]) => actions.reduce<ChatQueue<string>>(chatQueue, emptyChatQueue<string>());

test("Apply correction: the corrected question goes next, the queued follow-up once after it", () => {
  const s = run({ type: "ask", text: ACTIVE }, { type: "ask", text: "Actually, Scout 4" }, { type: "ask", text: "Then check delivery to Paarl" });
  const fix = s.queue[0];
  const corrected = chatQueue(s, { type: "correct", id: fix.id, text: correctedQuestion(ACTIVE, fix.text) });
  assert.deepEqual(corrected.queue.map((i) => i.text), [`${ACTIVE}\n\nCorrection: Scout 4`, "Then check delivery to Paarl"]);

  // Stopped: the corrected question runs, then Paarl — once.
  const stopped = chatQueue(chatQueue(corrected, { type: "stopping" }), { type: "finished", id: s.running!.id });
  assert.equal(stopped.running?.text, `${ACTIVE}\n\nCorrection: Scout 4`);
  const after = chatQueue(stopped, { type: "finished", id: stopped.running!.id });
  assert.equal(after.running?.text, "Then check delivery to Paarl");
  assert.equal(after.queue.length, 0, "Paarl runs once");

  // Too late (it had just finished): the corrected question is simply the next turn.
  const late = chatQueue(chatQueue(chatQueue(corrected, { type: "stopping" }), { type: "stopRefused" }), { type: "finished", id: s.running!.id });
  assert.equal(late.running?.text, `${ACTIVE}\n\nCorrection: Scout 4`);
  assert.deepEqual(late.queue.map((i) => i.text), ["Then check delivery to Paarl"]);

  // A message no longer queued (it already went) changes nothing.
  assert.equal(chatQueue(after, { type: "correct", id: fix.id, text: "x" }), after);
});

test("the chat offers it on queued messages and stops through the same Stop the button uses", () => {
  const hook = readFileSync(new URL("../src/components/useApplyCorrection.ts", import.meta.url), "utf8");
  assert.ok(hook.indexOf('type: "correct"') < hook.indexOf("stopAsking(current.key)"), "queued first, then stopped");
  assert.match(hook, /current\.stopper\.abort\(\);/);
  assert.doesNotMatch(hook, /\bDAX\b/, "the workspace's own assistant name, never a hard-coded one");
  const chat = readFileSync(new URL("../src/components/AssistantChat.tsx", import.meta.url), "utf8");
  assert.match(chat, /correction\.offer\(item\) && \(/);
});
