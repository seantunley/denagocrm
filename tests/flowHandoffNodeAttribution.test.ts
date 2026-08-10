import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * A handoff was counted in the summary and attributed to no node in the graph.
 *
 * Once the bot hands over it is not positioned anywhere, so both runners write the
 * paused session with `nodeId: null` — correct for the runtime. The analytics
 * trigger copies that straight into `flow_handoff`, and that feeds the `handoffs`
 * column of the per-node funnel. So a conversation handed off on its FIRST turn,
 * before any session existed, appeared in the totals and pointed at nothing: the
 * node that gives up on customers was invisible in the one report built to find it.
 */

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => ({ ok: true }),
  handoff: async () => {},
};

test("a first-turn handoff reports the node it handed off from", async () => {
  const flow: Flow = {
    start: "greet",
    nodes: {
      greet: { id: "greet", type: "message", text: "Hi", next: "giveUp" },
      giveUp: { id: "giveUp", type: "handoff", text: "Let me get a person." },
    },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hello" }, baseCtx);
  assert.equal(result.handedOff, true);
  assert.equal(result.session, null, "a handoff leaves no position — which is why nodeId cannot carry this");
  assert.equal(result.endedAt, "giveUp", "the funnel needs to know WHICH node gave up");
});

test("an AI node that escalates reports itself, not the node before it", async () => {
  const flow: Flow = {
    start: "chat",
    nodes: { chat: { id: "chat", type: "ai" } },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "I want a refund" }, {
    ...baseCtx,
    aiReply: async () => ({ reply: "Getting someone", handoff: true }),
  });
  assert.equal(result.handedOff, true);
  assert.equal(result.endedAt, "chat");
});

test("a mid-conversation AI escalation reports the node the customer was sitting on", async () => {
  const flow: Flow = {
    start: "chat",
    nodes: { chat: { id: "chat", type: "ai" } },
  };
  // Resuming AT the ai node takes the pre-loop branch, which is a different return.
  const result = await runFlow(flow, { nodeId: "chat", vars: {} }, { text: "still not happy" }, {
    ...baseCtx,
    aiReply: async () => ({ reply: "Getting someone", handoff: true }),
  });
  assert.equal(result.handedOff, true);
  assert.equal(result.endedAt, "chat");
});

test("a completed conversation reports where it finished", async () => {
  const flow: Flow = {
    start: "greet",
    nodes: {
      greet: { id: "greet", type: "message", text: "Hi", next: "bye" },
      bye: { id: "bye", type: "end" },
    },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hello" }, baseCtx);
  assert.equal(result.handedOff, false);
  assert.equal(result.session, null);
  assert.equal(result.endedAt, "bye");
});

test("a flow still waiting reports no ending, because session.nodeId already says where it is", async () => {
  const flow: Flow = {
    start: "ask",
    nodes: {
      ask: { id: "ask", type: "capture", text: "Your name?", variable: "name", next: "bye" },
      bye: { id: "bye", type: "end" },
    },
  };
  const result = await runFlow(flow, { nodeId: null, vars: {} }, { text: "hi" }, baseCtx);
  assert.equal(result.session?.nodeId, "ask");
  assert.equal(result.endedAt, undefined, "reporting an ending for a turn that has not ended would double-count");
});

test("both runners carry the ending node into the paused session", () => {
  // The trigger cannot see a function return value; it reads the row. The reserved
  // key rides in `vars`, exactly as __flow_version already does.
  const run = src("src/lib/flowRun.ts");
  assert.match(run, /const HANDOFF_NODE_VAR = "__handoff_node";/);
  assert.match(run, /storedVars\(session\.vars, snapshot\.versionId, result\.endedAt\)/);
  assert.match(run, /\.\.\.\(endedAt \? \{ \[HANDOFF_NODE_VAR\]: endedAt \} : \{\}\)/);

  const session = src("src/lib/flowSession.ts");
  assert.match(session, /storedState\(state, result\.endedAt\)/);
  assert.match(session, /\.\.\.\(endedAt \? \{ hn: endedAt \} : \{\}\)/);

  // Only the handoff path. An ACTIVE session's own nodeId is the truth, and
  // stamping this on it would let a stale key outlive the turn that set it.
  assert.doesNotMatch(run, /storedVars\(result\.session\.vars, snapshot\.versionId, result\.endedAt\)/);
  assert.doesNotMatch(session, /vars: storedState\(state, result\.endedAt\), status: "active"/);
});

test("the trigger prefers a real node over the NULL a paused session must carry", () => {
  const sql = src("prisma/migrations/20260810140000_bot_flow_handoff_node_attribution/migration.sql");
  const body = sql.replace(/^\s*--.*$/gm, "");

  // Two key names because the two runners serialise differently and always have —
  // the same split as __flow_version / fv, not a third convention.
  assert.match(body, /handoff_node := COALESCE\(NULLIF\(NEW\."vars", ''\)::jsonb ->> '__handoff_node', NULLIF\(NEW\."vars", ''\)::jsonb ->> 'hn'\)/);

  // No flow_handoff may still be written with a bare NULL node.
  assert.doesNotMatch(body, /version_id, NULL, 'flow_handoff'/);
  // The UPDATE path keeps OLD."nodeId" — the node the bot was waiting at is a
  // better answer than the one it ended on — but falls back rather than to NULL.
  assert.match(body, /COALESCE\(OLD\."nodeId", handoff_node\), 'flow_handoff'/);

  // CREATE OR REPLACE is inherently re-runnable, which the runner requires: it
  // opens no transaction and records a migration only after executing it.
  assert.match(body, /CREATE OR REPLACE FUNCTION "record_bot_flow_session_event"\(\)/);
  // And the failure handler that keeps analytics from aborting a customer's turn
  // must survive this rewrite — the body is otherwise 20260810090000 verbatim.
  assert.match(body, /EXCEPTION WHEN OTHERS THEN/);
  assert.match(body, /RAISE WARNING 'record_bot_flow_session_event skipped/);
});

test("the per-node funnel is what consumes this, so the column has to exist", () => {
  // If `handoffs` were not a per-node column, none of the above would matter.
  const analytics = src("src/lib/botFlowAnalytics.ts");
  assert.match(analytics, /COUNT\(\*\) FILTER \(WHERE "eventType" = 'flow_handoff'\) AS "handoffs"/);
  assert.match(analytics, /AND "nodeId" IS NOT NULL/, "a NULL-node handoff is dropped from the funnel entirely");
});
