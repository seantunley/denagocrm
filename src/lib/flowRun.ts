import { prisma } from "./db";
import { getSetting } from "./settings";
import { formatZAR } from "./format";
import { matchByPhone } from "./whatsapp";
import { generateBotReply, type BotMsg } from "./botAi";
import { sendPushToAll } from "./push";
import { maybeAutoReply, botShouldPause } from "./bot";
import { greetingVars } from "./flowSession";
import { resolveTenantActor } from "./tenantActor";
import { crmActions } from "./flowActions";
import { runFlow, type FlowInput, type FlowSession, type FlowCtx } from "./flow";
import { resolveFlowSnapshot } from "./flowPublishing";
import { enqueueBotMessages, flushBotOutboxConversation } from "./botOutbox";

export const FLOW_MARKER = "🤖 Flow";
const FLOW_VERSION_VAR = "__flow_version";

export async function isFlowEnabled(): Promise<boolean> {
  return (
    (await getSetting("BOT_ENABLED")) === "true" &&
    (await getSetting("BOT_FLOW_ENABLED")) === "true"
  );
}

const RESTART = /^\s*(menu|hi|hello|hey|start|restart|begin)\b/i;
const isRestart = (text: string) => RESTART.test(text);

async function loadSession(key: string): Promise<{
  nodeId: string | null;
  vars: Record<string, string>;
  flowVersionId: string | null;
  status: string;
} | null> {
  const row = await prisma.botSession.findUnique({ where: { channel_key: { channel: "whatsapp", key } } });
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    await prisma.botSession.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  let vars: Record<string, string> = {};
  try {
    vars = JSON.parse(row.vars);
  } catch {
    /* ignore */
  }
  const flowVersionId = vars[FLOW_VERSION_VAR] ?? null;
  delete vars[FLOW_VERSION_VAR];
  return { nodeId: row.nodeId, vars, flowVersionId, status: row.status };
}

async function saveSession(
  key: string,
  session: FlowSession,
  flowVersionId: string | null,
  status = "active",
  hours = 24,
) {
  const storedVars = {
    ...session.vars,
    ...(flowVersionId ? { [FLOW_VERSION_VAR]: flowVersionId } : {}),
  };
  const data = {
    nodeId: session.nodeId,
    vars: JSON.stringify(storedVars),
    status,
    expiresAt: new Date(Date.now() + hours * 3600 * 1000),
  };
  await prisma.botSession.upsert({
    where: { channel_key: { channel: "whatsapp", key } },
    update: data,
    create: { channel: "whatsapp", key, ...data },
  });
}

async function clearSession(key: string) {
  await prisma.botSession.deleteMany({ where: { channel: "whatsapp", key } });
}

async function priceList(): Promise<string> {
  const products = await prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } });
  if (!products.length) return "I'll have the team send you our current pricing 👍";
  return (
    "Here's our current range:\n" +
    products
      .map((p) => `• ${p.name}${p.basePriceCents ? ` — from ${formatZAR(p.basePriceCents)}` : ""}` + (p.colors.length ? ` (${p.colors.map((c) => c.name).join(", ")})` : ""))
      .join("\n")
  );
}

async function coloursList(): Promise<string> {
  const products = await prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } });
  const lines = products.filter((p) => p.colors.length).map((p) => `${p.name}: ${p.colors.map((c) => c.name).join(", ")}`);
  return lines.length ? "Our colours:\n" + lines.join("\n") : "Ask me about a specific model and I'll list its colours 🎨";
}

async function whatsappHistory(contactId: string | null, leadId: string | null, digits: string): Promise<BotMsg[]> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const or: any[] = [];
  if (contactId) or.push({ contactId });
  if (leadId) or.push({ leadId });
  or.push({ body: { contains: digits } });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const comms = await prisma.communication.findMany({
    where: { type: "whatsapp", OR: or },
    orderBy: { occurredAt: "desc" },
    take: 16,
  });
  return comms
    .reverse()
    .map((c) => ({ role: (c.direction === "inbound" ? "user" : "assistant") as "user" | "assistant", content: c.body.replace(/\n\n\[to \+?\d+\]\s*$/, "").trim() }))
    .filter((m) => m.content);
}

function buildCtx(digits: string, match: { contactId: string | null; leadId: string | null }): FlowCtx {
  return {
    dynamicAnswer: (source) => (source === "colours" ? coloursList() : priceList()),
    aiReply: async () => {
      let name: string | null = null;
      let isCustomer = false;
      if (match.contactId) {
        const c = await prisma.contact.findUnique({ where: { id: match.contactId } });
        name = c?.firstName ?? null;
        isCustomer = true;
      } else if (match.leadId) {
        const l = await prisma.lead.findUnique({ where: { id: match.leadId } });
        name = l?.name?.split(" ")[0] ?? null;
      }
      const history = await whatsappHistory(match.contactId, match.leadId, digits);
      const ai = await generateBotReply({ history, customerName: name, isCustomer });
      return ai ?? { reply: "Let me get one of our team to help you with that — they'll be in touch shortly 👍", handoff: true };
    },
    handoff: async () => {
      await sendPushToAll({ title: "WhatsApp needs you 🙋", body: "The assistant handed a chat over to a human.", url: match.contactId ? `/contacts/${match.contactId}` : match.leadId ? `/leads/${match.leadId}` : "/inbox" }, "bot_handoff").catch(() => {});
    },
    ...crmActions("whatsapp", { contactId: match.contactId, leadId: match.leadId }),
  };
}

/** Runs the published flow for a WhatsApp message. Returns true if handled. */
export async function runWhatsAppFlow(digits: string, input: FlowInput): Promise<boolean> {
  const match = await matchByPhone(digits);
  if (await botShouldPause(match.contactId, match.leadId, digits)) return true;

  const existing = await loadSession(digits);
  if (existing?.status === "paused") return true;

  const restart = isRestart(input.text) && !input.choiceId;
  let seed: Record<string, string> = {};
  if (!existing || restart) {
    const contact = match.contactId ? await prisma.contact.findUnique({ where: { id: match.contactId } }) : null;
    seed = greetingVars(contact?.firstName ?? null);
  }
  const session: FlowSession = !existing || restart
    ? { nodeId: null, vars: seed }
    : { nodeId: existing.nodeId, vars: existing.vars };

  const actor = await resolveTenantActor();
  if (!actor) {
    console.error("[bot] refusing to reply on whatsapp: no tenant actor, so the reply could not be recorded");
    return true;
  }

  const snapshot = await resolveFlowSnapshot("whatsapp", restart ? null : existing?.flowVersionId ?? null);
  const result = await runFlow(snapshot.flow, session, input, buildCtx(digits, match));

  // First make the outbound intent durable. If this insert fails, no BotSession
  // state below is committed and the inbound webhook can safely be retried.
  await enqueueBotMessages({
    channel: "whatsapp",
    key: digits,
    messages: result.messages,
    contactId: match.contactId,
    leadId: match.leadId,
    actorId: actor.id,
  });

  // Then commit the new conversation position. At this point every message that
  // explains the position exists durably even if the process dies before send.
  if (result.handedOff) await saveSession(digits, { nodeId: null, vars: session.vars }, snapshot.versionId, "paused", 6);
  else if (result.session) await saveSession(digits, result.session, snapshot.versionId);
  else await clearSession(digits);

  // Finally attempt immediate delivery. Failure is NOT fatal to the flow: the
  // queued rows remain retryable and the cron will pick them up in order.
  await flushBotOutboxConversation("whatsapp", digits);
  return true;
}

/**
 * Single WhatsApp entry point. Voice notes and the AI-off case use the
 * conversational/keyword bot; otherwise, when a flow is enabled, run the flow.
 */
export async function runWhatsAppBot(
  digits: string,
  input: FlowInput,
  opts: { voiceNote?: boolean } = {},
): Promise<void> {
  if (opts.voiceNote) {
    await maybeAutoReply(digits, input.text, { voiceNote: true });
    return;
  }
  if (await isFlowEnabled()) {
    await runWhatsAppFlow(digits, input);
    return;
  }
  await maybeAutoReply(digits, input.text);
}
