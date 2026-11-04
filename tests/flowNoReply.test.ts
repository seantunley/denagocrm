import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { armNoReply, LAST_INBOUND, NO_REPLY_AT, NO_REPLY_NODE, noReplyDue } from "../src/lib/flowNoReply";
import { validateFlow } from "../src/lib/flowValidation";

// Node-RED's trigger node (Sean, 2026-11-04): "if they don't answer within 30 minutes, send a nudge".
const ctx = { handoff: async () => {}, aiReply: async () => ({ reply: "", handoff: false }), dynamicAnswer: async () => "", createBooking: async () => ({ ok: true }) } as unknown as FlowCtx;
const flow: Flow = {
  start: "menu",
  nodes: {
    menu: { id: "menu", type: "choice", text: "What can we help with?", options: [{ id: "a", label: "Prices", next: "prices" }], noReply: { minutes: 30, next: "nudge" } },
    prices: { id: "prices", type: "message", text: "From R29,999" },
    nudge: { id: "nudge", type: "message", text: "Still there? Tap a button any time 🙂", next: "ask" },
    ask: { id: "ask", type: "capture", text: "Or just tell us your name", variable: "name", next: "thanks" },
    thanks: { id: "thanks", type: "message", text: "Thanks {{name}}" },
  },
};
const said = (r: { messages: { type: string; text?: string }[] }) => r.messages.map((m) => m.text ?? "");
const MIN = 60_000;

test("no answer in time: the question's no-reply route runs; an answer is untouched", async () => {
  const waiting = { nodeId: "menu", vars: {} };
  const timedOut = await runFlow(flow, waiting, { text: "", timedOut: true }, ctx);
  assert.deepEqual(said(timedOut), ["Still there? Tap a button any time 🙂", "Or just tell us your name"]);
  assert.equal(timedOut.session?.nodeId, "ask");
  const answered = await runFlow(flow, waiting, { text: "Prices", choiceId: "menu|a" }, ctx);
  assert.deepEqual(said(answered), ["From R29,999"]);
});

test("a question with no no-reply route stays put and says nothing — a silence is never an answer", async () => {
  const result = await runFlow(flow, { nodeId: "ask", vars: {} }, { text: "", timedOut: true }, ctx);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.session, { nodeId: "ask", vars: {} });
});

test("the deadline: armed from the customer's message, cleared when moving on, never past WhatsApp's window", () => {
  const now = Date.UTC(2026, 10, 4, 9, 0);
  const armed = armNoReply(flow, { nodeId: "menu", vars: {} }, now, true);
  assert.equal(armed[LAST_INBOUND], String(now));
  assert.equal(armed[NO_REPLY_AT], String(now + 30 * MIN));
  assert.equal(armed[NO_REPLY_NODE], "menu");
  const moved = armNoReply(flow, { nodeId: "ask", vars: armed }, now + MIN, true);
  assert.equal(moved[NO_REPLY_AT], undefined, "the next question has no no-reply: nothing armed");
  // A nudge that waits again, 23h40 after the customer last wrote: 30 more minutes would cross 24h — not armed.
  const late = armNoReply(flow, { nodeId: "menu", vars: { [LAST_INBOUND]: String(now) } }, now + (23 * 60 + 40) * MIN, false);
  assert.equal(late[NO_REPLY_AT], undefined);
  assert.equal(late[LAST_INBOUND], String(now), "a sweep turn is not the customer writing");
});

test("due only on the same question, after its time, inside the 24 hours", () => {
  const now = Date.UTC(2026, 10, 4, 9, 0);
  const vars = { [NO_REPLY_AT]: String(now - MIN), [NO_REPLY_NODE]: "menu", [LAST_INBOUND]: String(now - 31 * MIN) };
  assert.equal(noReplyDue("menu", vars, now), true);
  assert.equal(noReplyDue("ask", vars, now), false, "moved on since");
  assert.equal(noReplyDue("menu", { ...vars, [NO_REPLY_AT]: String(now + MIN) }, now), false, "not yet");
  assert.equal(noReplyDue("menu", { ...vars, [LAST_INBOUND]: String(now - 25 * 60 * MIN) }, now), false, "window closed");
});

test("validation: the wait is 30 minutes to 23 hours, and the route is a real connection", () => {
  const bad: Flow = { ...flow, nodes: { ...flow.nodes, menu: { ...flow.nodes.menu, noReply: { minutes: 5, next: "gone" } } as Flow["nodes"][string] } };
  const codes = validateFlow(bad).map((i) => i.code);
  assert.ok(codes.includes("no_reply.minutes"));
  assert.ok(codes.includes("graph.missing_target"));
  assert.ok(!validateFlow(flow).some((i) => i.code.startsWith("no_reply") || (i.code === "graph.unreachable" && i.nodeId === "nudge")), "the nudge is reachable through it");
});

test("wiring: the runner checks and fences the sweep's turn; the sweep rides the 30-minute outbox run", () => {
  const run = readFileSync("src/lib/flowRun.ts", "utf8");
  assert.match(run, /if \(noReply && \(!existing \|\| existing\.ownership !== "bot" \|\| existing\.nodeId !== noReply\.nodeId \|\| existing\.vars\[NO_REPLY_AT\] !== noReply\.at\)\) return true;/);
  assert.match(run, /if \(result\.session\) result\.session\.vars = armNoReply\(snapshot\.flow, result\.session, Date\.now\(\), !noReply\);/);
  const fence = run.indexOf("botSessionStillWaitingTx(tx");
  assert.ok(fence > run.indexOf("botStillOwnsTx(tx") && fence < run.indexOf("enqueueBotMessagesTx(tx"), "checked after the row is locked, before anything is queued");
  assert.match(readFileSync("src/app/api/cron/bot-outbox/route.ts", "utf8"), /const noReply = await sweepNoReply\(budget\.shouldStop\);/);
  assert.ok(!readFileSync("vercel.json", "utf8").includes("bot-no-reply"), "no faster job of its own: the interval is the bill");
});
