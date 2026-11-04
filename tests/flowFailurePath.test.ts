import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { publishSeverity, validateFlow } from "../src/lib/flowValidation";

// Node-RED's catch node (Sean, 2026-11-04): one "If anything fails" step for the whole flow.
const ctx = (ok: boolean) => ({
  handoff: async () => {},
  aiReply: async () => ({ reply: "", handoff: false }),
  dynamicAnswer: async () => "",
  createBooking: async () => (ok ? { ok: true } : { ok: false, reason: "down" }),
  httpRequest: async () => (ok ? { ok: true, status: 200, body: "{}" } : { ok: false, status: 503, reason: "down" }),
} as unknown as FlowCtx);

const flow = (onFailure?: string): Flow => ({
  start: "book",
  nodes: {
    book: { id: "book", type: "booking", text: "Booked!", next: "api" },
    api: { id: "api", type: "http", method: "GET", url: "https://api.example.com/x", next: "done", failureNext: "sorry" },
    sorry: { id: "sorry", type: "message", text: "That API is down." },
    done: { id: "done", type: "message", text: "All done." },
    team: { id: "team", type: "handoff", text: "Passing you to the team." },
  },
  ...(onFailure ? { onFailure } : {}),
});
const said = (r: { messages: { type: string; text?: string }[] }) => r.messages.map((m) => m.text ?? "");

test("a step that fails with no route of its own goes to the 'If anything fails' step", async () => {
  const result = await runFlow(flow("team"), { nodeId: null, vars: {} }, { text: "hi" }, ctx(false));
  assert.deepEqual(said(result), ["Passing you to the team."]);
  assert.equal(result.handedOff, true);
});

test("a step's own failure route still wins; success is untouched; no fallback = the turn ends as before", async () => {
  const f = flow("team");
  f.nodes.book = { id: "book", type: "booking", text: "Booked!", next: "api", failureNext: "done" };
  assert.deepEqual(said(await runFlow(f, { nodeId: null, vars: {} }, { text: "hi" }, ctx(false))), ["All done."]);
  assert.deepEqual(said(await runFlow(flow("team"), { nodeId: null, vars: {} }, { text: "hi" }, ctx(true))), ["Booked!", "All done."]);
  const none = await runFlow(flow(), { nodeId: null, vars: {} }, { text: "hi" }, ctx(false));
  assert.deepEqual(said(none), []);
  assert.equal(none.session, null);
});

test("the fallback step failing does not loop back to itself", async () => {
  const f: Flow = { start: "api", nodes: { api: { id: "api", type: "http", method: "GET", url: "https://api.example.com/x", next: "done" }, done: { id: "done", type: "end" } }, onFailure: "api" };
  const result = await runFlow(f, { nodeId: null, vars: {} }, { text: "hi" }, ctx(false));
  assert.deepEqual(said(result), []);
  assert.equal(result.session, null);
});

test("the fallback is one-shot per turn: a failure on its own path ends the turn instead of looping (PR #983 review)", async () => {
  // API A fails → fallback message → API B fails → (would be) fallback message again → API B …
  const calls: string[] = [];
  const looping: Flow = {
    start: "a",
    nodes: {
      a: { id: "a", type: "http", method: "GET", url: "https://a.example.com", next: "done" },
      fb: { id: "fb", type: "message", text: "Sorry, something went wrong.", next: "b" },
      b: { id: "b", type: "http", method: "GET", url: "https://b.example.com", next: "done" },
      done: { id: "done", type: "end" },
    },
    onFailure: "fb",
  };
  const failing = { ...ctx(false), httpRequest: async (input: { url: string }) => { calls.push(input.url); return { ok: false, status: 503, reason: "down" }; } } as unknown as FlowCtx;
  const result = await runFlow(looping, { nodeId: null, vars: {} }, { text: "hi" }, failing);
  assert.deepEqual(said(result), ["Sorry, something went wrong."], "the fallback's message once, not until the step guard");
  assert.deepEqual(calls, ["https://a.example.com", "https://b.example.com"], "each API called once");
  assert.equal(result.session, null, "and the turn ends");
});

test("validation: the fallback satisfies the publish check, is reachable, and must be a real step", () => {
  const noFallback = publishSeverity(validateFlow(flow()));
  assert.ok(noFallback.some((i) => i.code === "action.no_failure_branch" && i.nodeId === "book" && i.severity === "error"), "without it, publishing is refused as before");
  const withFallback = validateFlow(flow("team"));
  assert.ok(!withFallback.some((i) => i.code === "action.no_failure_branch"));
  assert.ok(!withFallback.some((i) => i.code === "graph.unreachable" && i.nodeId === "team"), "reached by failing, not by a wire");
  assert.ok(validateFlow(flow("gone")).some((i) => i.code === "flow.fallback_missing" && i.severity === "error"));
});

test("the builder saves it, restores it, undoes it, and clears it when its step is deleted", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /\.\.\.\(current\.current\.onFailure \? \{ onFailure: current\.current\.onFailure \} : \{\}\)/);
  assert.match(builder, /setOnFailure\(restored\.onFailure\);/);
  assert.match(builder, /if \(onFailure === id\) setOnFailure\(undefined\);/);
  assert.match(builder, /remember\(`fallback:\$\{id \?\? "none"\}`, true\);/);
});
