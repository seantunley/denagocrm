import { prisma } from "./db";
import { getSetting } from "./settings";
import { formatZAR } from "./format";
import { matchByPhone } from "./whatsapp";
import { generateBotReply, routeBotChoice, type BotMsg } from "./botAi";
import { sendPushToAll } from "./push";
import { maybeAutoReply } from "./bot";
import { flowRuntimeVars, greetingVars } from "./flowSession";
import { resolveTenantActor } from "./tenantActor";
import { crmActions } from "./flowActions";
import { runFlow, type FlowInput, type FlowSession, type FlowCtx, type FlowHandoffContext } from "./flow";
import { resolveFlowSnapshot } from "./flowPublishing";
import { flushBotOutboxConversation } from "./botOutbox";
import { enqueueBotMessagesTx } from "./botOutboxWrite";
import { withTenantWrite } from "./tenantWrite";
import { loadBotSession, upsertBotSessionTx, deleteBotSessionTx, botStillOwnsTx } from "./botSessionStore";
import { recordBotFlowEventsTx, type BotFlowEventInput } from "./botFlowAnalytics";
import { completeInboundBotEventTx, currentInboundBotClaim } from "./botInboundEvent";
import { decideInboundAct, type BotOwnership } from "./botOwnership";

export const FLOW_MARKER = "🤖 Flow";
const FLOW_VERSION_VAR = "__flow_version";
// Reserved, like __flow_version: the analytics trigger reads it out of the stored
// vars because a paused session's own `nodeId` is null by design.
const HANDOFF_NODE_VAR = "__handoff_node";
export async function isFlowEnabled(): Promise<boolean> { return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_FLOW_ENABLED")) === "true"; }

type LoadedSession = { nodeId: string | null; vars: Record<string, string>; flowVersionId: string | null; status: string; ownership: BotOwnership };
type ActionObservation = { nodeId: string; action: string; ok: boolean };

async function loadSession(key: string): Promise<LoadedSession | null> {
  const row = await loadBotSession("whatsapp", key);
  if (!row) return null;
  let vars: Record<string, string> = {};
  try { vars = JSON.parse(row.vars); } catch { /* ignore */ }
  const flowVersionId = vars[FLOW_VERSION_VAR] ?? null;
  delete vars[FLOW_VERSION_VAR];
  return { nodeId: row.nodeId, vars, flowVersionId, status: row.status, ownership: row.ownership };
}
function storedVars(vars: Record<string, string>, flowVersionId: string | null, endedAt?: string | null): string { return JSON.stringify({ ...vars, ...(flowVersionId ? { [FLOW_VERSION_VAR]: flowVersionId } : {}), ...(endedAt ? { [HANDOFF_NODE_VAR]: endedAt } : {}) }); }
function handoffBody(context?: FlowHandoffContext): string {
  const summary = context?.summary?.trim(); const reason = context?.reason?.trim();
  if (summary) return `${summary}${reason ? ` · ${reason}` : ""}`.slice(0, 220);
  if (reason) return `Handoff: ${reason}`.slice(0, 220);
  return "The assistant handed a chat over to a human.";
}

async function priceList(): Promise<string> {
  const products = await prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } });
  if (!products.length) return "I'll have the team send you our current pricing 👍";
  return "Here's our current range:\n" + products.map((p) => `• ${p.name}${p.basePriceCents ? ` — from ${formatZAR(p.basePriceCents)}` : ""}` + (p.colors.length ? ` (${p.colors.map((c) => c.name).join(", ")})` : "")).join("\n");
}
async function coloursList(): Promise<string> {
  const products = await prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } });
  const lines = products.filter((p) => p.colors.length).map((p) => `${p.name}: ${p.colors.map((c) => c.name).join(", ")}`);
  return lines.length ? "Our colours:\n" + lines.join("\n") : "Ask me about a specific model and I'll list its colours 🎨";
}
async function whatsappHistory(contactId: string | null, leadId: string | null, digits: string): Promise<BotMsg[]> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const or: any[] = [];
  if (contactId) or.push({ contactId }); if (leadId) or.push({ leadId }); or.push({ body: { contains: digits } });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const comms = await prisma.communication.findMany({ where: { type: "whatsapp", OR: or }, orderBy: { occurredAt: "desc" }, take: 16 });
  return comms.reverse().map((c) => ({ role: (c.direction === "inbound" ? "user" : "assistant") as "user" | "assistant", content: c.body.replace(/\n\n\[to \+?\d+\]\s*$/, "").trim() })).filter((m) => m.content);
}

function buildCtx(digits: string, match: { contactId: string | null; leadId: string | null }, actions: ActionObservation[]): FlowCtx {
  return {
    dynamicAnswer: (source) => source === "colours" ? coloursList() : priceList(),
    routeChoice: ({ prompt, text, options }) => routeBotChoice({ prompt, text, options }),
    recordAction: (nodeId, action, ok) => actions.push({ nodeId, action, ok }),
    aiReply: async () => {
      let name: string | null = null; let isCustomer = false;
      if (match.contactId) { const c = await prisma.contact.findUnique({ where: { id: match.contactId } }); name = c?.firstName ?? null; isCustomer = true; }
      else if (match.leadId) { const l = await prisma.lead.findUnique({ where: { id: match.leadId } }); name = l?.name?.split(" ")[0] ?? null; }
      return (await generateBotReply({ history: await whatsappHistory(match.contactId, match.leadId, digits), customerName: name, isCustomer })) ?? { reply: "Let me get one of our team to help you with that — they'll be in touch shortly 👍", handoff: true, confidence: "low", intent: "unknown", handoffReason: "AI unavailable" };
    },
    handoff: async (_vars, context) => { await sendPushToAll({ title: "WhatsApp needs you 🙋", body: handoffBody(context), url: match.contactId ? `/contacts/${match.contactId}` : match.leadId ? `/leads/${match.leadId}` : "/inbox" }, "bot_handoff").catch(() => {}); },
    ...crmActions("whatsapp", { contactId: match.contactId, leadId: match.leadId }),
  };
}

function actionEvents(digits: string, flowVersionId: string | null, actions: ActionObservation[]): BotFlowEventInput[] {
  return actions.filter((a) => a.ok).map((a) => ({ channel: "whatsapp", conversationKey: digits, flowVersionId, nodeId: a.nodeId, eventType: "crm_action", metadata: { action: a.action } }));
}

export async function runWhatsAppFlow(digits: string, input: FlowInput): Promise<boolean> {
  const match = await matchByPhone(digits);
  const existing = await loadSession(digits);
  // Same rule as DM/Telegram, from the same module — but `status === "paused"`
  // could not tell a bot handoff from a staff takeover, so on WhatsApp too a
  // customer saying "hi" to the salesperson helping them restarted the flow on
  // top of that person. Ownership decides now.
  const decision = decideInboundAct({
    ownership: existing ? existing.ownership : null,
    text: input.text,
    hasChoiceId: Boolean(input.choiceId),
  });
  if (decision.act === "suppress") return true;
  const restart = decision.act === "restart";

  let seed: Record<string, string> = {};
  if (!existing || restart) {
    const contact = match.contactId ? await prisma.contact.findUnique({ where: { id: match.contactId } }) : null;
    seed = greetingVars(contact?.firstName ?? null);
  }
  const builtins = flowRuntimeVars("whatsapp");
  const session: FlowSession = !existing || restart ? { nodeId: null, vars: { ...builtins, ...seed } } : { nodeId: existing.nodeId, vars: { ...existing.vars, ...builtins } };

  const actor = await resolveTenantActor();
  if (!actor) { console.error("[bot] refusing to reply on whatsapp: no tenant actor, so the reply could not be recorded"); return true; }

  const snapshot = await resolveFlowSnapshot("whatsapp", restart ? null : existing?.flowVersionId ?? null);
  const actions: ActionObservation[] = [];
  const result = await runFlow(snapshot.flow, session, input, buildCtx(digits, match, actions));

  await withTenantWrite(async (tx, tenantId) => {
    // Fence the whole turn, not just the session write. The AI call above can take
    // seconds; a salesperson can press Take over during it. Guarding only the
    // session update meant ownership was correctly kept while THIS turn's reply
    // had already been queued — so the bot still sent one more message over the
    // person. FOR UPDATE holds the row for the rest of this transaction, so a
    // takeover cannot slip in between the check and the enqueue.
    if (!(await botStillOwnsTx(tx, tenantId, "whatsapp", digits))) return;
    // Acknowledge the provider event in the SAME transaction as the graph move.
    // Completing it afterwards left a window where the session and outbox committed,
    // the process died, and the redelivery then replayed the old message against an
    // already-advanced graph — a phone number read as the answer to the next question.
    await completeInboundBotEventTx(tx, tenantId, currentInboundBotClaim());
    if (restart) await tx.$executeRawUnsafe(`SELECT set_config('app.bot_flow_transition', 'restart', true)`);
    await enqueueBotMessagesTx(tx, tenantId, { channel: "whatsapp", key: digits, messages: result.messages, flowVersionId: snapshot.versionId, contactId: match.contactId, leadId: match.leadId, actorId: actor.id });

    const events = actionEvents(digits, snapshot.versionId, actions);
    const oneShot = (!existing || restart) && !result.session && !result.handedOff && Boolean(snapshot.versionId);
    if (oneShot) {
      events.push(
        { channel: "whatsapp", conversationKey: digits, flowVersionId: snapshot.versionId, eventType: "flow_started", metadata: { source: "runtime_one_shot" } },
        { channel: "whatsapp", conversationKey: digits, flowVersionId: snapshot.versionId, eventType: "flow_completed", metadata: { source: "runtime_one_shot" } },
      );
    }
    if (events.length) await recordBotFlowEventsTx(tx, tenantId, events);

    if (result.handedOff) await upsertBotSessionTx(tx, tenantId, { channel: "whatsapp", key: digits, nodeId: null, vars: storedVars(session.vars, snapshot.versionId, result.endedAt), status: "paused", ownership: "ai_handoff", expiresAt: new Date(Date.now() + 6 * 3600 * 1000) });
    else if (result.session) await upsertBotSessionTx(tx, tenantId, { channel: "whatsapp", key: digits, nodeId: result.session.nodeId, vars: storedVars(result.session.vars, snapshot.versionId), status: "active", ownership: "bot", expiresAt: new Date(Date.now() + 24 * 3600 * 1000) });
    else await deleteBotSessionTx(tx, tenantId, "whatsapp", digits);
  });

  await flushBotOutboxConversation("whatsapp", digits);
  return true;
}

export async function runWhatsAppBot(digits: string, input: FlowInput, opts: { voiceNote?: boolean } = {}): Promise<void> {
  // Ownership gates EVERY route into the bot, not just the flow runner.
  //
  // maybeAutoReply never reads BotSession — its only brake is botShouldPause, a
  // timestamp heuristic over the last outbound Communication, and the legacy
  // keyword path has no brake at all. Pressing Take over writes no Communication,
  // so that heuristic still sees the bot as the last speaker. A voice note (or
  // any message at all when BOT_FLOW_ENABLED is off) therefore reached the AI and
  // it answered over the salesperson — the exact thing conversation ownership
  // exists to prevent, entered through a door the ownership check did not cover.
  const owned = await loadSession(digits);
  if (owned) {
    const gate = decideInboundAct({
      ownership: owned.ownership,
      text: input.text,
      // A voice note is not a typed control command, so it can never be a resume.
      hasChoiceId: Boolean(input.choiceId) || Boolean(opts.voiceNote),
    });
    if (gate.act === "suppress") return;
  }

  if (opts.voiceNote) { await maybeAutoReply(digits, input.text, { voiceNote: true }); return; }
  if (await isFlowEnabled()) { await runWhatsAppFlow(digits, input); return; }
  await maybeAutoReply(digits, input.text);
}
