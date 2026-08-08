import { prisma } from "./db";
import { getSetting } from "./settings";
import { formatZAR } from "./format";
import {
  matchByPhone,
  sendWhatsAppText,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendWhatsAppImage,
} from "./whatsapp";
import { generateBotReply, type BotMsg } from "./botAi";
import { sendPushToAll } from "./push";
import { maybeAutoReply, botShouldPause } from "./bot";
import { greetingVars } from "./flowSession";
import { resolveTenantActor } from "./tenantActor";
import { crmActions } from "./flowActions";
import { runFlow, DEFAULT_FLOW, type Flow, type FlowInput, type FlowSession, type FlowCtx } from "./flow";

export const FLOW_MARKER = "🤖 Flow";

export async function isFlowEnabled(): Promise<boolean> {
  return (
    (await getSetting("BOT_ENABLED")) === "true" &&
    (await getSetting("BOT_FLOW_ENABLED")) === "true"
  );
}

async function getActiveFlow(): Promise<Flow> {
  const row = await prisma.botFlow.findFirst({ where: { channel: "whatsapp", active: true } });
  if (row) {
    try {
      const f = JSON.parse(row.definition);
      if (f?.start && f?.nodes) return f as Flow;
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_FLOW;
}

const RESTART = /^\s*(menu|hi|hello|hey|start|restart|begin)\b/i;
const isRestart = (text: string) => RESTART.test(text);

/* ---- persistence ---- */
async function loadSession(key: string): Promise<{ nodeId: string | null; vars: Record<string, string>; status: string } | null> {
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
  return { nodeId: row.nodeId, vars, status: row.status };
}

async function saveSession(key: string, session: FlowSession, status = "active", hours = 24) {
  const data = {
    nodeId: session.nodeId,
    vars: JSON.stringify(session.vars),
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

/* ---- context (IO the engine calls) ---- */
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
    orderBy: { occurredAt: "asc" },
    take: 16,
  });
  return comms
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

async function logOutbound(
  text: string,
  contactId: string | null,
  leadId: string | null,
  digits: string,
  actorId: string,
) {
  // The actor is PASSED IN, resolved before anything was sent. It used to be
  // resolved here with `if (!firstUser) return`, so a missing tenant actor meant
  // the customer had the message and the CRM had no record of it. Review found
  // this on the Messenger side; it was always true here too, and copying the
  // pattern would have established parity without audit safety.
  await prisma.communication.create({
    data: {
      type: "whatsapp",
      direction: "outbound",
      subject: FLOW_MARKER,
      body: contactId || leadId ? text : `${text}\n\n[to +${digits}]`,
      contactId,
      leadId,
      userId: actorId,
    },
  });
}

/** Runs the active flow for a WhatsApp message. Returns true if handled. */
export async function runWhatsAppFlow(digits: string, input: FlowInput): Promise<boolean> {
  const match = await matchByPhone(digits);
  if (await botShouldPause(match.contactId, match.leadId, digits)) return true; // human is handling

  const existing = await loadSession(digits);
  if (existing?.status === "paused") return true; // waiting for a human after a handoff

  const restart = isRestart(input.text) && !input.choiceId;
  let seed: Record<string, string> = {};
  if (!existing || restart) {
    const contact = match.contactId ? await prisma.contact.findUnique({ where: { id: match.contactId } }) : null;
    seed = greetingVars(contact?.firstName ?? null);
  }
  const session: FlowSession =
    !existing || restart ? { nodeId: null, vars: seed } : { nodeId: existing.nodeId, vars: existing.vars };

  // FAIL CLOSED BEFORE SENDING ANYTHING. Without a tenant actor a reply cannot be
  // recorded, and a bot that talks to a customer with no trace of it is worse
  // than a bot that stays quiet.
  const actor = await resolveTenantActor();
  if (!actor) {
    console.error("[bot] refusing to reply on whatsapp: no tenant actor, so the reply could not be recorded");
    return true;
  }

  const flow = await getActiveFlow();
  const result = await runFlow(flow, session, input, buildCtx(digits, match));

  for (const m of result.messages) {
    let ok = false;
    if (m.type === "text") {
      ok = (await sendWhatsAppText(digits, m.text)).ok;
      if (ok) await logOutbound(m.text, match.contactId, match.leadId, digits, actor.id);
    } else if (m.type === "image") {
      ok = (await sendWhatsAppImage(digits, m.url, m.caption)).ok;
      if (ok) await logOutbound(m.caption ? `🖼 ${m.caption}` : "🖼 [image]", match.contactId, match.leadId, digits, actor.id);
    } else {
      // choice: buttons (≤3) or list (>3)
      const res =
        m.options.length <= 3
          ? await sendWhatsAppButtons(digits, m.text, m.options.map((o) => ({ id: o.id, title: o.label })))
          : await sendWhatsAppList(digits, m.text, "Choose", m.options.map((o) => ({ id: o.id, title: o.label, description: o.description })));
      ok = res.ok;
      if (ok) await logOutbound(`${m.text}\n${m.options.map((o) => `• ${o.label}`).join("\n")}`, match.contactId, match.leadId, digits, actor.id);
    }
  }

  if (result.handedOff) await saveSession(digits, { nodeId: null, vars: session.vars }, "paused", 6);
  else if (result.session) await saveSession(digits, result.session);
  else await clearSession(digits);
  return true;
}

/**
 * Single WhatsApp entry point. Voice notes and the AI-off case use the
 * conversational/keyword bot; otherwise, when a flow is enabled, run the flow.
 */
export async function runWhatsAppBot(
  digits: string,
  input: FlowInput,
  opts: { voiceNote?: boolean } = {}
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
