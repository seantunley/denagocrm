import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { chatQueue, emptyChatQueue, type ChatQueue, type ChatQueueAction } from "../src/components/chatQueue";

const run = (...actions: ChatQueueAction<string>[]) => actions.reduce<ChatQueue<string>>(chatQueue, emptyChatQueue<string>());

test("asking while DAX works queues it — one answer at a time, in order", () => {
  const s = run({ type: "ask", text: "Quotes for the six-seater?" }, { type: "ask", text: " Wait, I meant the four-seater " }, { type: "ask", text: "And Anna?" });
  assert.equal(s.running?.text, "Quotes for the six-seater?");
  assert.deepEqual(s.queue.map((i) => i.text), ["Wait, I meant the four-seater", "And Anna?"]);
  // Finished: the next goes in the same step — never two running, never idle with a queue.
  const next = chatQueue(s, { type: "finished", id: s.running!.id });
  assert.equal(next.running?.text, "Wait, I meant the four-seater");
  assert.deepEqual(next.queue.map((i) => i.text), ["And Anna?"]);
  const last = chatQueue(chatQueue(next, { type: "finished", id: next.running!.id }), { type: "finished", id: 3 });
  assert.equal(last.running, null);
  assert.equal(last.queue.length, 0);
});

test("nothing to send is ignored; an image alone is a question", () => {
  assert.deepEqual(run({ type: "ask", text: "   " }), emptyChatQueue<string>());
  assert.equal(run({ type: "ask", text: "", image: "photo" }).running?.image, "photo");
});

test("a queued message can be removed (or taken back to edit) before it goes", () => {
  const s = run({ type: "ask", text: "a" }, { type: "ask", text: "b" }, { type: "ask", text: "c" });
  const without = chatQueue(s, { type: "remove", id: s.queue[0].id });
  assert.deepEqual(without.queue.map((i) => i.text), ["c"]);
  assert.equal(without.running?.text, "a", "the running one is not touched");
});

test("Stop: stopping until the server answers; stopped moves on to the queue; too late keeps waiting", () => {
  const s = run({ type: "ask", text: "wrong" }, { type: "ask", text: "right" });
  const stopping = chatQueue(s, { type: "stopping" });
  assert.equal(stopping.stopping, true);
  // Too late: still running, Stop can be pressed again later.
  const refused = chatQueue(stopping, { type: "stopRefused" });
  assert.equal(refused.stopping, false);
  assert.equal(refused.running?.text, "wrong");
  // Stopped: the correction goes next.
  const stopped = chatQueue(stopping, { type: "finished", id: s.running!.id });
  assert.equal(stopped.stopping, false);
  assert.equal(stopped.running?.text, "right");
  // A stale finish (an id no longer running) changes nothing.
  assert.equal(chatQueue(stopped, { type: "finished", id: s.running!.id }), stopped);
  // Nothing running: nothing to stop.
  assert.equal(chatQueue(emptyChatQueue<string>(), { type: "stopping" }).stopping, false);
});

test("the chat: composer usable while DAX works, Stop beside the answer, queued and stopped said aloud", () => {
  const chat = readFileSync(new URL("../src/components/AssistantChat.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(chat, /disabled=\{pending/, "nothing in the composer is locked while an answer is coming");
  assert.match(chat, /useReducer\(chatQueue<Blob>/);
  assert.match(chat, /\{ key, signal: stopper\.signal \}/);
  // Stop aborts the read only once the SERVER says it stopped (stopAsking) — otherwise the answer stands.
  assert.match(chat, /if \(!\(await stopAsking\(current\.key\)\)\) \{\s*dispatch\(\{ type: "stopRefused" \}\);/);
  assert.match(chat, /stopped\s*\? \{ question: shown, stopped: true, rows: \[\] \}/, "a stopped turn carries no cards, choices or rows");
  assert.match(chat, /aria-live="polite"/);
  assert.match(chat, /if \(heard\.ok\) ask\(heard\.text\);/, "a voice note queues like typing");
});
