/**
 * Shared multi-channel flow runner. Any messaging channel (Messenger,
 * Instagram, Telegram, …) uses this to advance a conversation: it manages the
 * BotSession state + transcript and delegates IO to a per-channel FlowCtx.
 */
import type { BotMsg } from "./botAi";
import { runFlow, type Flow, type FlowCtx, type FlowInput, type OutMsg } from "./flow";
import { resolveFlowSnapshot } from "./flowPublishing";
import { withTenantWrite, type TenantWriteTx } from "./tenantWrite";
import { loadBotSession, upsertBotSessionTx, deleteBotSessionTx } from "./botSessionStore";
import { recordBotFlowEventsTx, type BotFlowEventInput } from "./botFlowAnalytics";

export type SessionState = {
  nodeId: string | null;
  vars: Record<string, string>;
  msgs: BotMsg[];
  flowVersionId: string | null;
};

const RESTART = /^\s*(menu|hi|hello|hey|start|restart|begin)\b/i;

export function greetingVars(firstName: string | null): Record<string, string> {
  return firstName
    ? { first_name: firstName, name: firstName, known: "1", greeting: `Hey ${firstName} 👋 Welcome back to Denago Cape Town!` }
    : { greeting: "Hi there 👋 Welcome to Denago Cape Town!" };
}

export function flowRuntimeVars(channel: string, now = new Date()): Record<string, string> {
  return {
    channel,
    current_date: new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(now),
    current_time: new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false }).format(now),
  };
}

export async function getActiveFlowFor(channel: string): Promise<Flow> {
  return (await resolveFlowSnapshot(channel)).flow;
}

async function loadState(channel: string, key: string): Promise<(SessionState & { status: string }) | null> {
  const row = await loadBotSession(channel, key);
  if (!row) return null;
  try {
    const p = JSON.parse(row.vars);
    return { nodeId: row.nodeId, vars: p.v ?? {}, msgs: p.m ?? [], flowVersionId: p.fv ?? null, status: row.status };
  } catch {
    return { nodeId: row.nodeId, vars: {}, msgs: [], flowVersionId: null, status: row.status };
  }
}

function storedState(state: SessionState): string {
  return JSON.stringify({ v: state.vars, m: state.msgs.slice(-20), fv: state.flowVersionId });
}

function recordBotMsgs(state: SessionState, messages: OutMsg[]) {
  for (const m of messages) {
    const text = m.type === "text" ? m.text : m.type === "image" ? m.caption || "[image]" : `${m.text}\n${m.options.map((o) => `• ${o.label}`).join("\n")}`;
    state.msgs.push({ role: "assistant", content: text });
  }
}

export type ChannelResult = { messages: OutMsg[]; done: boolean; suppressed?: boolean };
export type PersistFlowMessages = (
  messages: OutMsg[],
  tx: TenantWriteTx,
  tenantId: string,
  flowVersionId: string | null,
) => Promise<void>;

type ActionObservation = { nodeId: string; action: string; ok: boolean };

function analyticsEvents(input: {
  channel: string;
  key: string;
  flowVersionId: string | null;
  actions: ActionObservation[];
  oneShot: boolean;
}): BotFlowEventInput[] {
  const events: BotFlowEventInput[] = input.actions
    .filter((action) => action.ok)
    .map((action) => ({
      channel: input.channel,
      conversationKey: input.key,
      flowVersionId: input.flowVersionId,
      nodeId: action.nodeId,
      eventType: "crm_action",
      metadata: { action: action.action },
    }));
  if (input.oneShot && input.flowVersionId) {
    events.push(
      { channel: input.channel, conversationKey: input.key, flowVersionId: input.flowVersionId, eventType: "flow_started", metadata: { source: "runtime_one_shot" } },
      { channel: input.channel, conversationKey: input.key, flowVersionId: input.flowVersionId, eventType: "flow_completed", metadata: { source: "runtime_one_shot" } },
    );
  }
  return events;
}

export async function advanceFlow(
  channel: string,
  key: string,
  input: FlowInput,
  makeCtx: (state: SessionState) => FlowCtx,
  seedVars?: Record<string, string>,
  persistMessages?: PersistFlowMessages,
): Promise<ChannelResult> {
  const existing = await loadState(channel, key);
  const restart = !input.choiceId && RESTART.test(input.text);
  const builtins = flowRuntimeVars(channel);

  if (existing?.status === "paused" && !restart) return { messages: [], done: true, suppressed: true };

  const state: SessionState = !existing || restart
    ? { nodeId: null, vars: { ...builtins, ...(seedVars ?? {}) }, msgs: [], flowVersionId: null }
    : { nodeId: existing.nodeId, vars: { ...existing.vars, ...builtins }, msgs: existing.msgs, flowVersionId: existing.flowVersionId };

  if (input.text.trim()) state.msgs.push({ role: "user", content: input.text });

  const snapshot = await resolveFlowSnapshot(channel, restart ? null : state.flowVersionId);
  state.flowVersionId = snapshot.versionId;
  const actions: ActionObservation[] = [];
  const ctx = makeCtx(state);
  const originalRecordAction = ctx.recordAction;
  ctx.recordAction = (nodeId, action, ok) => {
    originalRecordAction?.(nodeId, action, ok);
    actions.push({ nodeId, action, ok });
  };
  const result = await runFlow(snapshot.flow, { nodeId: state.nodeId, vars: state.vars }, input, ctx);
  recordBotMsgs(state, result.messages);

  await withTenantWrite(async (tx, tenantId) => {
    // The BotSession analytics trigger uses this local transaction flag to avoid
    // treating a restart as completion/progression of the old conversation.
    if (restart) await tx.$executeRawUnsafe(`SELECT set_config('app.bot_flow_transition', 'restart', true)`);

    if (result.messages.length && persistMessages) await persistMessages(result.messages, tx, tenantId, snapshot.versionId);

    const oneShot = (!existing || restart) && !result.session && !result.handedOff;
    const events = analyticsEvents({ channel, key, flowVersionId: snapshot.versionId, actions, oneShot });
    if (events.length) await recordBotFlowEventsTx(tx, tenantId, events);

    if (result.session) {
      state.nodeId = result.session.nodeId;
      state.vars = result.session.vars;
      await upsertBotSessionTx(tx, tenantId, { channel, key, nodeId: state.nodeId, vars: storedState(state), status: "active", expiresAt: new Date(Date.now() + 12 * 3600 * 1000) });
      return;
    }

    if (result.handedOff) {
      await upsertBotSessionTx(tx, tenantId, { channel, key, nodeId: null, vars: storedState(state), status: "paused", expiresAt: new Date(Date.now() + 6 * 3600 * 1000) });
      return;
    }

    await deleteBotSessionTx(tx, tenantId, channel, key);
  });

  return result.session ? { messages: result.messages, done: false } : { messages: result.messages, done: true };
}
