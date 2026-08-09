/**
 * Shared multi-channel flow runner. Any messaging channel (Messenger,
 * Instagram, Telegram, …) uses this to advance a conversation: it manages the
 * BotSession state + transcript and delegates IO to a per-channel FlowCtx.
 * Each channel adapter renders/delivers the returned OutMsg[] through its own
 * durable outbox.
 */
import { prisma } from "./db";
import type { BotMsg } from "./botAi";
import { runFlow, type Flow, type FlowCtx, type FlowInput, type OutMsg } from "./flow";
import { resolveFlowSnapshot } from "./flowPublishing";

export type SessionState = {
  nodeId: string | null;
  vars: Record<string, string>;
  msgs: BotMsg[];
  flowVersionId: string | null;
};

const RESTART = /^\s*(menu|hi|hello|hey|start|restart|begin)\b/i;

/** Seed variables so a flow can greet a known customer by name. */
export function greetingVars(firstName: string | null): Record<string, string> {
  return firstName
    ? { first_name: firstName, name: firstName, known: "1", greeting: `Hey ${firstName} 👋 Welcome back to Denago Cape Town!` }
    : { greeting: "Hi there 👋 Welcome to Denago Cape Town!" };
}

/** Backwards-compatible helper for callers that only need the current graph. */
export async function getActiveFlowFor(channel: string): Promise<Flow> {
  return (await resolveFlowSnapshot(channel)).flow;
}

async function loadState(channel: string, key: string): Promise<(SessionState & { status: string }) | null> {
  const row = await prisma.botSession.findUnique({ where: { channel_key: { channel, key } } });
  if (!row || row.expiresAt < new Date()) return null;
  try {
    const p = JSON.parse(row.vars);
    return {
      nodeId: row.nodeId,
      vars: p.v ?? {},
      msgs: p.m ?? [],
      flowVersionId: p.fv ?? null,
      status: row.status,
    };
  } catch {
    return { nodeId: row.nodeId, vars: {}, msgs: [], flowVersionId: null, status: row.status };
  }
}

async function saveState(channel: string, key: string, state: SessionState, status = "active", hours = 12) {
  const data = {
    nodeId: state.nodeId,
    vars: JSON.stringify({ v: state.vars, m: state.msgs.slice(-20), fv: state.flowVersionId }),
    status,
    expiresAt: new Date(Date.now() + hours * 3600 * 1000),
  };
  await prisma.botSession.upsert({
    where: { channel_key: { channel, key } },
    update: data,
    create: { channel, key, ...data },
  });
}

async function clearState(channel: string, key: string) {
  await prisma.botSession.deleteMany({ where: { channel, key } });
}

function recordBotMsgs(state: SessionState, messages: OutMsg[]) {
  for (const m of messages) {
    const text = m.type === "text" ? m.text : m.type === "image" ? m.caption || "[image]" : `${m.text}\n${m.options.map((o) => `• ${o.label}`).join("\n")}`;
    state.msgs.push({ role: "assistant", content: text });
  }
}

export type ChannelResult = { messages: OutMsg[]; done: boolean; suppressed?: boolean };

/**
 * Advance the flow for one inbound message on a channel.
 *
 * `persistMessages`, when supplied, MUST durably persist the outbound work before
 * this function commits the new BotSession state. This is the ordering guarantee
 * that prevents "CRM/session says step 7, customer only saw step 5" when the
 * provider or serverless invocation fails between deciding and delivering a reply.
 */
export async function advanceFlow(
  channel: string,
  key: string,
  input: FlowInput,
  makeCtx: (state: SessionState) => FlowCtx,
  seedVars?: Record<string, string>,
  persistMessages?: (messages: OutMsg[]) => Promise<void>,
): Promise<ChannelResult> {
  const existing = await loadState(channel, key);
  const restart = !input.choiceId && RESTART.test(input.text);

  if (existing?.status === "paused" && !restart) {
    return { messages: [], done: true, suppressed: true }; // a human is handling
  }

  const state: SessionState = !existing || restart
    ? { nodeId: null, vars: { ...(seedVars ?? {}) }, msgs: [], flowVersionId: null }
    : {
        nodeId: existing.nodeId,
        vars: existing.vars,
        msgs: existing.msgs,
        flowVersionId: existing.flowVersionId,
      };

  if (input.text.trim()) state.msgs.push({ role: "user", content: input.text });

  const snapshot = await resolveFlowSnapshot(channel, restart ? null : state.flowVersionId);
  state.flowVersionId = snapshot.versionId;
  const result = await runFlow(snapshot.flow, { nodeId: state.nodeId, vars: state.vars }, input, makeCtx(state));
  recordBotMsgs(state, result.messages);

  // Persist the send intent BEFORE advancing/clearing/pausing the session. If the
  // insert fails, the webhook can be retried and the old session remains truthful.
  if (result.messages.length && persistMessages) await persistMessages(result.messages);

  if (result.session) {
    state.nodeId = result.session.nodeId;
    state.vars = result.session.vars;
    await saveState(channel, key, state, "active");
    return { messages: result.messages, done: false };
  }
  if (result.handedOff) {
    await saveState(channel, key, { ...state, nodeId: null }, "paused", 6);
    return { messages: result.messages, done: true };
  }
  await clearState(channel, key);
  return { messages: result.messages, done: true };
}
