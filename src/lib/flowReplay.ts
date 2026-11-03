import "server-only";
import { prisma } from "./db";
import type { Flow } from "./flow";
import { matchByPhone } from "./whatsapp";
import { greetingVars, flowRuntimeVars } from "./flowSession";
import { getCompanyProfile } from "./companyProfile";
import { checkReplay, replayMessages, type ReplayRun } from "./flowReplayRun";

/**
 * REPLAY A REAL CONVERSATION (Node-RED review 2026-11-02, Sean's item 3): "why did the bot say that?".
 *
 * The step events (BotFlowEvent, written by a database trigger) record where a conversation PAUSED, but not the steps
 * that ran on their own in between, nor what the customer typed. So a replay runs it again: the published VERSION it
 * ran on, fed the customer's real WhatsApp messages in order, through the production engine with every effect stubbed
 * (lib/flowReplayRun — nothing sent, nothing written, no AI or API call). Owner only (actions/flowReplay); nothing here
 * is logged.
 */

export type ReplayConversation = { eventId: string; channel: string; who: string; startedAt: string; version: number; outcome: string };
export type ReplayResult = ({ ok: true; version: number; notes: string[]; check: { matches: boolean; text: string } } & ReplayRun) | { ok: false; error: string };

const DAY = 86_400_000;
/** Only the last digits of a number or handle reach the page. */
const mask = (key: string) => (key.length > 4 ? `…${key.slice(-4)}` : key);

const versionsOf = (tenantId: string, flowId: string) =>
  prisma.botFlowVersion.findMany({ where: { tenantId, flowId }, select: { id: true, version: true, definition: true } });

/** This flow's conversations in the last 30 days, newest first, each with how it ended. */
export async function listReplayConversations(tenantId: string, flowId: string): Promise<ReplayConversation[]> {
  const versions = await versionsOf(tenantId, flowId);
  if (!versions.length) return [];
  const versionNo = new Map(versions.map((v) => [v.id, v.version]));
  const starts = await prisma.botFlowEvent.findMany({
    where: { tenantId, eventType: "flow_started", flowVersionId: { in: [...versionNo.keys()] }, occurredAt: { gte: new Date(Date.now() - 30 * DAY) } },
    orderBy: { occurredAt: "desc" },
    take: 40,
    select: { id: true, channel: true, conversationKey: true, flowVersionId: true, occurredAt: true },
  });
  if (!starts.length) return [];
  const ends = await prisma.botFlowEvent.findMany({
    where: { tenantId, eventType: { in: ["flow_handoff", "flow_completed"] }, conversationKey: { in: [...new Set(starts.map((s) => s.conversationKey))] }, occurredAt: { gte: starts.at(-1)!.occurredAt } },
    orderBy: { occurredAt: "asc" },
    select: { conversationKey: true, channel: true, eventType: true, occurredAt: true },
  });
  return starts.map((s) => {
    const end = ends.find((e) => e.conversationKey === s.conversationKey && e.channel === s.channel && e.occurredAt >= s.occurredAt);
    return {
      eventId: s.id,
      channel: s.channel,
      who: mask(s.conversationKey),
      startedAt: s.occurredAt.toISOString(),
      version: versionNo.get(s.flowVersionId ?? "") ?? 0,
      outcome: !end ? "stopped part-way" : end.eventType === "flow_handoff" ? "handed to the team" : "finished",
    };
  });
}

export async function replayConversation(tenantId: string, flowId: string, eventId: string): Promise<ReplayResult> {
  const start = await prisma.botFlowEvent.findFirst({ where: { id: eventId, tenantId, eventType: "flow_started" }, select: { channel: true, conversationKey: true, flowVersionId: true, occurredAt: true } });
  const version = start?.flowVersionId ? (await versionsOf(tenantId, flowId)).find((v) => v.id === start.flowVersionId) : undefined;
  if (!start || !version) return { ok: false, error: "That conversation isn't one of this flow's." };
  if (start.channel !== "whatsapp") return { ok: false, error: "Replay covers WhatsApp conversations for now." };
  let flow: Flow;
  try { flow = JSON.parse(version.definition) as Flow; } catch { return { ok: false, error: "That version can't be read." }; }

  const key = { tenantId, channel: start.channel, conversationKey: start.conversationKey };
  const next = await prisma.botFlowEvent.findFirst({ where: { ...key, eventType: "flow_started", occurredAt: { gt: start.occurredAt } }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } });
  const to = next?.occurredAt ?? new Date(+start.occurredAt + DAY);
  const match = await matchByPhone(start.conversationKey);
  if (!match.contactId) return { ok: false, error: "The customer's messages for this conversation can't be found." };
  // The message is logged just BEFORE the flow starts, so look a little earlier — then keep only the last one before
  // the start (the one that started it), not the previous conversation's tail.
  const rows = await prisma.communication.findMany({
    where: { contactId: match.contactId, type: "whatsapp", direction: "inbound", occurredAt: { gte: new Date(+start.occurredAt - 2 * 60_000), lt: to } },
    orderBy: { occurredAt: "asc" },
    take: 60,
    select: { body: true, occurredAt: true },
  });
  const after = rows.findIndex((r) => r.occurredAt > start.occurredAt);
  const messages = rows.slice(Math.max(0, (after === -1 ? rows.length : after) - 1));
  const bodies = messages.map((r) => r.body ?? "");
  if (!bodies.length) return { ok: false, error: "No messages from the customer in that conversation." };

  const events = await prisma.botFlowEvent.findMany({
    where: { ...key, eventType: { in: ["crm_action", "node_waiting", "flow_handoff", "flow_completed"] }, occurredAt: { gte: start.occurredAt, lt: to } },
    orderBy: { occurredAt: "asc" },
    select: { eventType: true, nodeId: true, occurredAt: true },
  });
  // Each recorded success belongs to the turn of the last customer message before it (PR #974 review: a step that
  // failed once and worked later must fail and then work in the replay too, not work both times).
  const recordedByTurn = new Map<number, Set<string>>();
  for (const e of events) {
    if (e.eventType !== "crm_action" || !e.nodeId) continue;
    const turn = Math.max(1, messages.filter((m) => m.occurredAt <= e.occurredAt).length);
    recordedByTurn.set(turn, (recordedByTurn.get(turn) ?? new Set()).add(e.nodeId));
  }
  const recordedWaits = events.filter((e) => e.eventType === "node_waiting" && e.nodeId).map((e) => e.nodeId!);
  const end = events.find((e) => e.eventType === "flow_handoff" || e.eventType === "flow_completed");
  const recordedEnd = !end ? null : end.eventType === "flow_handoff" ? "handed off" as const : "finished" as const;
  const contact = await prisma.contact.findUnique({ where: { id: match.contactId }, select: { firstName: true } });
  const vars = { ...flowRuntimeVars("whatsapp", start.occurredAt), ...greetingVars(contact?.firstName ?? null, (await getCompanyProfile()).name) };
  const loadSubflow = async (childId: string, versionId?: string) => {
    const row = versionId
      ? await prisma.botFlowVersion.findFirst({ where: { id: versionId, tenantId, flowId: childId }, select: { definition: true } })
      : await prisma.botFlowVersion.findFirst({ where: { tenantId, flowId: childId, createdAt: { lte: start.occurredAt } }, orderBy: { version: "desc" }, select: { definition: true } });
    try { return row ? (JSON.parse(row.definition) as Flow) : null; } catch { return null; }
  };
  const run = await replayMessages(flow, bodies, { vars, recordedByTurn, loadSubflow });
  return {
    ok: true,
    version: version.version,
    ...run,
    check: checkReplay(run, recordedWaits, recordedEnd),
    notes: [
      `A re-run, not a recording: v${version.version} — the version this conversation ran on — fed the customer's real messages. Nothing was sent or changed.`,
      "AI, knowledge, API and booking-slot steps are not re-run; a step marked “assumed” depended on one, so what follows it is a guess. Bookings and Journeys count as done only where the real conversation recorded them, in the same turn.",
    ],
  };
}
