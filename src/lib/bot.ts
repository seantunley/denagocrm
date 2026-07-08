import { prisma } from "./db";
import { getSetting } from "./settings";
import { sendWhatsAppText, matchByPhone } from "./whatsapp";
import { sendPushToAll } from "./push";
import { isBotAiEnabled, generateBotReply, type BotMsg } from "./botAi";

export type BotRule = { id: string; keywords: string; reply: string };

export async function getBotRules(): Promise<BotRule[]> {
  const raw = await getSetting("BOT_RULES");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** South Africa has no DST — a fixed +2 offset is safe. */
function saNow(): Date {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

async function withinOfficeHours(): Promise<boolean> {
  const hours = (await getSetting("BOT_HOURS")) || "08:00-17:00";
  const days = (await getSetting("BOT_DAYS")) || "1,2,3,4,5";
  const now = saNow();
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  if (!days.split(",").includes(String(day))) return false;
  const [start, end] = hours.split("-");
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const toMin = (t: string) => {
    const [h, m] = t.trim().split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  return minutes >= toMin(start ?? "08:00") && minutes < toMin(end ?? "17:00");
}

const AUTO_MARKER = "🤖 Auto-reply";
const AI_MARKER = "🤖 Assistant";

/* eslint-disable @typescript-eslint/no-explicit-any */
function whereOr(contactId: string | null, leadId: string | null, digits: string): any[] {
  const or: any[] = [];
  if (contactId) or.push({ contactId });
  if (leadId) or.push({ leadId });
  or.push({ body: { contains: digits } });
  return or;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function cleanBody(body: string): string {
  return body.replace(/\n\n\[to \+?\d+\]\s*$/, "").trim();
}

/** Pause the bot while a human is actively handling, or just after a handoff. */
async function botShouldPause(contactId: string | null, leadId: string | null, digits: string): Promise<boolean> {
  const last = await prisma.communication.findFirst({
    where: { type: "whatsapp", direction: "outbound", OR: whereOr(contactId, leadId, digits) },
    orderBy: { occurredAt: "desc" },
  });
  if (!last) return false;
  const ageH = (Date.now() - last.occurredAt.getTime()) / 3.6e6;
  const subj = last.subject ?? "";
  const isBot = subj.startsWith("🤖");
  if (!isBot && ageH < 12) return true; // a human replied — leave it to them
  if (subj.includes("handoff") && ageH < 6) return true; // waiting for a human after a handoff
  return false;
}

async function buildHistory(contactId: string | null, leadId: string | null, digits: string): Promise<BotMsg[]> {
  const comms = await prisma.communication.findMany({
    where: { type: "whatsapp", OR: whereOr(contactId, leadId, digits) },
    orderBy: { occurredAt: "asc" },
    take: 16,
  });
  return comms
    .map((c) => ({ role: (c.direction === "inbound" ? "user" : "assistant") as "user" | "assistant", content: cleanBody(c.body) }))
    .filter((m) => m.content);
}

async function logOutbound(reply: string, subject: string, contactId: string | null, leadId: string | null, digits: string) {
  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) return;
  await prisma.communication.create({
    data: {
      type: "whatsapp",
      direction: "outbound",
      subject,
      body: contactId || leadId ? reply : `${reply}\n\n[to +${digits}]`,
      contactId,
      leadId,
      userId: firstUser.id,
    },
  });
}

/**
 * WhatsApp bot. When the AI assistant is on, Claude routes each message to a
 * defined FAQ pathway (exact answer) or replies conversationally — grounded in
 * the real range, prices, hours and brief — and hands off to a human when
 * needed. Voice notes always reply then hand off. With the AI off, it falls
 * back to phase-1 keyword rules + an after-hours away message.
 */
export async function maybeAutoReply(
  fromDigits: string,
  text: string,
  opts: { voiceNote?: boolean } = {}
): Promise<void> {
  if ((await getSetting("BOT_ENABLED")) !== "true") return;
  const { contactId, leadId } = await matchByPhone(fromDigits);

  // ---- AI assistant path ----
  if (await isBotAiEnabled()) {
    if (await botShouldPause(contactId, leadId, fromDigits)) return;
    const history = await buildHistory(contactId, leadId, fromDigits);
    if (history.length === 0) history.push({ role: "user", content: text });

    let name: string | null = null;
    let isCustomer = false;
    if (contactId) {
      const c = await prisma.contact.findUnique({ where: { id: contactId } });
      name = c?.firstName ?? null;
      isCustomer = true;
    } else if (leadId) {
      const l = await prisma.lead.findUnique({ where: { id: leadId } });
      name = l?.name?.split(" ")[0] ?? null;
    }

    const ai = await generateBotReply({ history, customerName: name, isCustomer, voiceNote: opts.voiceNote });
    if (ai) {
      const handoff = ai.handoff || Boolean(opts.voiceNote);
      const sent = await sendWhatsAppText(fromDigits, ai.reply);
      if (!sent.ok) return;
      await logOutbound(ai.reply, handoff ? `${AI_MARKER} → handoff` : AI_MARKER, contactId, leadId, fromDigits);
      if (handoff) {
        await sendPushToAll(
          {
            title: "WhatsApp needs you 🙋",
            body: `${name ?? "A customer"} — the assistant handed the chat over.`,
            url: contactId ? `/contacts/${contactId}` : leadId ? `/leads/${leadId}` : "/inbox",
          },
          "bot_handoff"
        ).catch(() => {});
      }
      return;
    }
    // AI unavailable → fall through to the legacy fallback below.
  }

  // ---- Legacy keyword-rule path (AI off, or AI failed) ----
  const clean = text.toLowerCase();
  let reply: string | null = null;
  let ruleName = "";
  for (const rule of await getBotRules()) {
    const hit = rule.keywords
      .toLowerCase()
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .some((k) => clean.includes(k));
    if (hit) {
      reply = rule.reply;
      ruleName = rule.keywords.split(",")[0];
      break;
    }
  }

  if (!reply) {
    if (await withinOfficeHours()) return;
    const awayMsg = await getSetting("BOT_AFTERHOURS_MSG");
    if (!awayMsg) return;
    const recent = await prisma.communication.findFirst({
      where: {
        type: "whatsapp",
        direction: "outbound",
        subject: { contains: AUTO_MARKER },
        occurredAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
        OR: whereOr(contactId, leadId, fromDigits),
      },
    });
    if (recent) return;
    reply = awayMsg;
    ruleName = "after-hours";
  }

  const sent = await sendWhatsAppText(fromDigits, reply);
  if (!sent.ok) return;
  await logOutbound(reply, `${AUTO_MARKER} (${ruleName})`, contactId, leadId, fromDigits);
}
