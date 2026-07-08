/**
 * Shared multi-channel flow runner. Any messaging channel (Messenger,
 * Instagram, Telegram, …) uses this to advance a conversation: it manages the
 * BotSession state + transcript and delegates IO to a per-channel FlowCtx.
 * Each channel adapter just renders the returned OutMsg[] into its own format.
 */
import { prisma } from "./db";
import type { BotMsg } from "./botAi";
import { runFlow, DEFAULT_FLOW, type Flow, type FlowCtx, type FlowInput, type OutMsg } from "./flow";

export type SessionState = { nodeId: string | null; vars: Record<string, string>; msgs: BotMsg[] };

const RESTART = /^\s*(menu|hi|hello|hey|start|restart|begin)\b/i;

/** Seed variables so a flow can greet a known customer by name. */
export function greetingVars(firstName: string | null): Record<string, string> {
  return firstName
    ? { first_name: firstName, name: firstName, known: "1", greeting: `Hey ${firstName} 👋 Welcome back to Denago Cape Town!` }
    : { greeting: "Hi there 👋 Welcome to Denago Cape Town!" };
}

/** Active flow for a channel: its own live flow, else the live WhatsApp one. */
export async function getActiveFlowFor(channel: string): Promise<Flow> {
  const row =
    (await prisma.botFlow.findFirst({ where: { channel, active: true } })) ??
    (await prisma.botFlow.findFirst({ where: { channel: "whatsapp", active: true } }));
  if (row) {
    try {
      const f = JSON.parse(row.definition);
      if (f?.start && f?.nodes) return f as Flow;
    } catch {
      /* default */
    }
  }
  return DEFAULT_FLOW;
}

async function loadState(channel: string, key: string): Promise<(SessionState & { status: string }) | null> {
  const row = await prisma.botSession.findUnique({ where: { channel_key: { channel, key } } });
  if (!row || row.expiresAt < new Date()) return null;
  try {
    const p = JSON.parse(row.vars);
    return { nodeId: row.nodeId, vars: p.v ?? {}, msgs: p.m ?? [], status: row.status };
  } catch {
    return { nodeId: row.nodeId, vars: {}, msgs: [], status: row.status };
  }
}

async function saveState(channel: string, key: string, state: SessionState, status = "active", hours = 12) {
  const data = {
    nodeId: state.nodeId,
    vars: JSON.stringify({ v: state.vars, m: state.msgs.slice(-20) }),
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
 * Advance the flow for one inbound message on a channel. `makeCtx` receives the
 * mutable state (so the AI node can read the running transcript).
 */
export async function advanceFlow(
  channel: string,
  key: string,
  input: FlowInput,
  makeCtx: (state: SessionState) => FlowCtx,
  seedVars?: Record<string, string>
): Promise<ChannelResult> {
  const existing = await loadState(channel, key);
  const restart = !input.choiceId && RESTART.test(input.text);

  if (existing?.status === "paused" && !restart) {
    return { messages: [], done: true, suppressed: true }; // a human is handling
  }

  const state: SessionState = !existing || restart ? { nodeId: null, vars: { ...(seedVars ?? {}) }, msgs: [] } : { nodeId: existing.nodeId, vars: existing.vars, msgs: existing.msgs };
  if (existing && !restart) state.msgs.push({ role: "user", content: input.text });

  const flow = await getActiveFlowFor(channel);
  const result = await runFlow(flow, { nodeId: state.nodeId, vars: state.vars }, input, makeCtx(state));
  recordBotMsgs(state, result.messages);

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
