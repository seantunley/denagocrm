import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { armNoReply, fenceTimeoutEffects, LAST_INBOUND, NO_REPLY_AT, NO_REPLY_CLAIMED, NO_REPLY_CLAIMED_AT, NO_REPLY_NODE, noReplyDue, noReplyDueAt, noReplyEventId } from "../src/lib/flowNoReply";
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

test("a crashed claim is due again after 10 minutes; a fresh one isn't; an answer clears both", () => {
  const now = Date.UTC(2026, 10, 4, 9, 0);
  const base = { [NO_REPLY_NODE]: "menu", [LAST_INBOUND]: String(now - 60 * MIN), [NO_REPLY_CLAIMED]: "123" };
  assert.equal(noReplyDueAt("menu", { ...base, [NO_REPLY_CLAIMED_AT]: String(now - 2 * MIN) }, now), null);
  assert.equal(noReplyDueAt("menu", { ...base, [NO_REPLY_CLAIMED_AT]: String(now - 11 * MIN) }, now), "123", "the same deadline: the same identity");
  const answered = armNoReply(flow, { nodeId: "ask", vars: { ...base, [NO_REPLY_CLAIMED_AT]: "1" } }, now, true);
  assert.equal(answered[NO_REPLY_CLAIMED], undefined);
  assert.equal(answered[NO_REPLY_CLAIMED_AT], undefined);
  assert.equal(noReplyEventId("t", "27", "menu", "123"), "noreply:t:27:menu:123");
});

test("the action fence: while claimed, actions run; once the customer cancels it mid-run, that action and every later one don't", async () => {
  // A no-reply route with two actions; the customer's message lands between them (PR #988 second review).
  const route: Flow = {
    start: "q",
    nodes: {
      q: { id: "q", type: "capture", text: "Name?", variable: "name", next: "end", noReply: { minutes: 30, next: "book" } },
      book: { id: "book", type: "booking", action: "lead", text: "Logged", next: "j", failureNext: "end" },
      j: { id: "j", type: "journey", journeyId: "j1", next: "end", failureNext: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const acted: string[] = [];
  let claimed = true;
  const live = {
    ...ctx,
    createBooking: async () => { acted.push("booking"); claimed = false; /* the customer writes now */ return { ok: true }; },
    startJourney: async () => { acted.push("journey"); return { ok: true }; },
    handoff: async () => { acted.push("handoff"); },
  } as unknown as FlowCtx;
  const fence = fenceTimeoutEffects(live, async (act) => (claimed ? { allowed: true as const, value: await act() } : { allowed: false as const }));
  await runFlow(route, { nodeId: "q", vars: {} }, { text: "", timedOut: true }, live);
  assert.deepEqual(acted, ["booking"], "the booking ran while claimed; the Journey after the customer wrote did not");
  assert.equal(fence.superseded(), true, "and the runner drops the whole turn");
  // Once superseded, nothing acts even if asked again.
  claimed = true;
  assert.deepEqual(await (live.startJourney!("j1", {}, "j")), { ok: false, reason: "The customer replied first" });
  assert.equal(await live.handoff({}), undefined);
  assert.deepEqual(acted, ["booking"]);
});

test("wiring: the timeout is CLAIMED before any step runs, fenced on the claim, and runs under its own identity", () => {
  const run = readFileSync("src/lib/flowRun.ts", "utf8");
  const body = run.slice(run.indexOf("export async function runWhatsAppFlow"));
  assert.ok(body.indexOf("claimNoReplyTx(") > 0 && body.indexOf("claimNoReplyTx(") < body.indexOf("await runFlow("), "claimed before the flow runs (PR #988 review)");
  assert.ok(body.indexOf("cancelPendingNoReply(") > 0 && body.indexOf("cancelPendingNoReply(") < body.indexOf("await runFlow("), "a customer's message cancels any timeout before its own turn runs");
  // Every inbound message — a voice note too — cancels in the common entry, before it branches (third review).
  const bot = run.slice(run.indexOf("export async function runWhatsAppBot"));
  assert.ok(bot.indexOf("cancelPendingNoReply(digits, owned.vars)") > 0 && bot.indexOf("cancelPendingNoReply(digits, owned.vars)") < bot.indexOf("if (opts.voiceNote)"), "before the voice-note branch");
  // The cancel and each timeout action take the same per-conversation lock, so they never overlap.
  const cancel = run.slice(run.indexOf("async function cancelPendingNoReply"), run.indexOf("export type NoReplyTurn"));
  assert.match(cancel, /withNoReplyLock\("whatsapp", digits, \(tx, tenantId\) => cancelNoReplyTx\(/);
  assert.match(body, /fenceTimeoutEffects\(ctx, \(act\) => withNoReplyLock\("whatsapp", digits,/);
  assert.ok(body.indexOf("fenceTimeoutEffects(ctx") < body.indexOf("await runFlow("), "a timeout's actions are fenced before it runs");
  assert.ok(body.indexOf("if (fence?.superseded()) return true;") > body.indexOf("await runFlow(") && body.indexOf("if (fence?.superseded()) return true;") < body.indexOf("withBotConversationWrite(async (tx, tenantId) =>"), "a superseded timeout keeps nothing");
  assert.match(run, /if \(!claimed\) return true;/);
  assert.match(run, /existing\.vars\[NO_REPLY_CLAIMED\] !== noReply\.at\)\) return true;/);
  assert.match(run, /if \(result\.session\) result\.session\.vars = armNoReply\(snapshot\.flow, result\.session, Date\.now\(\), !noReply\);/);
  assert.match(run, /botSessionStillWaitingTx\(tx, tenantId, "whatsapp", digits, \{ \.\.\.noReply, atKey: NO_REPLY_CLAIMED \}\)/);
  const fence = run.lastIndexOf("botSessionStillWaitingTx(tx"); // the final fence (the first is the action fence)
  assert.ok(fence > run.indexOf("botStillOwnsTx(tx") && fence < run.indexOf("enqueueBotMessagesTx(tx"), "checked after the row is locked, before anything is queued");
  assert.match(readFileSync("src/lib/flowNoReplySweep.ts", "utf8"), /withInboundBotEvent\(\{ rowId: noReplyEventId\(tenantId, row\.key, nodeId, at\), leaseAttempt: null \}/);
  assert.match(readFileSync("src/app/api/cron/bot-outbox/route.ts", "utf8"), /const noReply = await sweepNoReply\(budget\.shouldStop\)[.;]/);
  assert.ok(!readFileSync("vercel.json", "utf8").includes("bot-no-reply"), "no faster job of its own: the interval is the bill");
});
