import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  HANDS_FREE, HANDS_FREE_OFF, freshVad, handsFreeStep, mayRecord, rms, vadStep, type HandsFree, type HandsFreeEvent,
} from "../src/lib/handsFree";

const run = (events: HandsFreeEvent[], from: HandsFree = HANDS_FREE_OFF) => events.reduce(handsFreeStep, from);

test("hands-free loops: listening → hearing → thinking → speaking → listening", () => {
  let s = run([{ type: "start" }]);
  assert.equal(s.phase, "listening");
  s = run([{ type: "spoke" }], s);
  assert.equal(s.phase, "hearing");
  s = run([{ type: "heard" }], s);
  assert.equal(s.phase, "thinking");
  s = run([{ type: "answered", speak: true }], s);
  assert.equal(s.phase, "speaking");
  s = run([{ type: "spokenEnd" }], s);
  assert.equal(s.phase, "listening");
  // An answer that can't be spoken (failed, stopped) goes straight back to listening.
  assert.equal(run([{ type: "start" }, { type: "spoke" }, { type: "heard" }, { type: "answered", speak: false }]).phase, "listening");
});

test("the microphone never records while DAX is speaking, thinking or hearing", () => {
  const speaking = run([{ type: "start" }, { type: "spoke" }, { type: "heard" }, { type: "answered", speak: true }]);
  assert.equal(mayRecord(speaking), false);
  // Nothing that arrives while speaking puts it back to listening early — only the end of the speech.
  for (const e of [{ type: "spoke" }, { type: "heard" }, { type: "notHeard" }, { type: "start" }, { type: "answered", speak: false }] as HandsFreeEvent[]) {
    assert.equal(handsFreeStep(speaking, e).phase, "speaking", e.type);
  }
  for (const phase of ["hearing", "thinking", "speaking", "off"] as const) assert.equal(mayRecord({ ...HANDS_FREE_OFF, phase }), false, phase);
  assert.equal(mayRecord({ ...HANDS_FREE_OFF, phase: "listening" }), true);
});

test("Stop stops from anywhere, and late events after it ask nothing", () => {
  for (const events of [[], [{ type: "spoke" }], [{ type: "spoke" }, { type: "heard" }]] as HandsFreeEvent[][]) {
    const s = run([{ type: "start" }, ...events, { type: "stop", reason: "why" }]);
    assert.deepEqual(s, { phase: "off", failures: 0, stopped: "why" });
    // A transcript or answer that lands after Stop changes nothing.
    assert.deepEqual(run([{ type: "heard" }, { type: "answered", speak: true }, { type: "spokenEnd" }], s), s);
  }
});

test("a run of hearings that came back empty stops it; one that worked resets the count", () => {
  const miss: HandsFreeEvent[] = [{ type: "spoke" }, { type: "notHeard" }];
  let s = run([{ type: "start" }, ...miss, ...miss]);
  assert.equal(s.phase, "listening");
  assert.equal(s.failures, 2);
  s = run([{ type: "spoke" }, { type: "heard" }, { type: "answered", speak: false }], s);
  assert.equal(s.failures, 0);
  s = run(Array.from({ length: HANDS_FREE.maxFailures }, () => miss).flat(), s);
  assert.equal(s.phase, "off");
  assert.match(s.stopped ?? "", /couldn't make out/);
});

/** Feed the detector a level for a while, in 100ms frames. */
function feed(level: number, ms: number, from = freshVad()) {
  let vad = from;
  let verdict = "wait";
  for (let t = 0; t < ms && verdict === "wait"; t += 100) ({ vad, verdict } = vadStep(vad, level, 100));
  return { vad, verdict };
}

test("silence detection: speech then a pause sends; a short noise doesn't; long silence is idle", () => {
  const quiet = feed(0.002, HANDS_FREE.calibrateMs).vad; // the room, measured
  const spoke = feed(0.2, 1500, quiet);
  assert.equal(spoke.verdict, "wait", "still talking");
  assert.equal(feed(0.001, 1100, spoke.vad).verdict, "wait", "a short pause between sentences doesn't send");
  assert.equal(feed(0.001, 1300, spoke.vad).verdict, "send", "a pause after speaking sends");
  // A cough: under the minimum speech, then quiet — never sent.
  const cough = feed(0.3, 200, quiet);
  assert.notEqual(feed(0.001, 5000, cough.vad).verdict, "send");
  assert.equal(feed(0.001, HANDS_FREE.idleMs + 200).verdict, "idle");
});

test("silence detection in a noisy workshop: steady noise is background, never a question; speech above it is", () => {
  // A compressor at 0.05 the whole time: measured as the room, so it never sends noise (which would come back empty
  // three times and stop hands-free).
  const room = feed(0.05, 8000);
  assert.equal(room.verdict, "wait");
  assert.ok(room.vad.floor > 0.04, String(room.vad.floor));
  // Speaking well above it, then the room again: sent.
  const spoke = feed(0.4, 1500, room.vad);
  assert.equal(feed(0.05, 1300, spoke.vad).verdict, "send");
  assert.equal(rms([0.5, -0.5, 0.5, -0.5]), 0.5);
});

test("someone already talking when listening starts is still heard: the gaps between words reset the background", () => {
  let vad = freshVad();
  for (let t = 0; t < 2000; t += 100) vad = vadStep(vad, t % 200 === 0 ? 0.2 : 0.003, 100).vad; // words and gaps
  assert.ok(vad.speechMs >= HANDS_FREE.minSpeechMs, String(vad.speechMs));
  assert.equal(feed(0.003, 1300, vad).verdict, "send");
});

test("the chat speaks only hands-free's own question, and shows the tap rule", () => {
  const chat = readFileSync(new URL("../src/components/AssistantChat.tsx", import.meta.url), "utf8");
  assert.match(chat, /handsFree\.answered\(q, !stopped && result\.ok \? result\.turnId : undefined\)/);
  assert.match(chat, /Anything that changes the CRM still needs a tap on its card\./);
  assert.match(chat, /const handsFreeOffered = listen && voice\.supported;/, "offered only where answers can be spoken");
  const hook = readFileSync(new URL("../src/components/useHandsFree.ts", import.meta.url), "utf8");
  assert.match(hook, /question !== asked\.current/);
  assert.match(hook, /if \(phase\.current !== "hearing"\) return; \/\/ stopped meanwhile: ask nothing/);
  assert.doesNotMatch(hook, /console\.|logError/, "no audio or words in logs");
});
