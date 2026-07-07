import { prisma } from "./db";
import { getSetting } from "./settings";
import { sendWhatsAppText, matchByPhone } from "./whatsapp";

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
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay(); // 1=Mon … 7=Sun
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

/**
 * Phase-1 WhatsApp bot: keyword rules answer instantly any time; outside
 * office hours an away message goes out (at most once per 4 hours per
 * customer). Anything unmatched is left for a human — the normal push
 * notification already fired.
 */
export async function maybeAutoReply(fromDigits: string, text: string): Promise<void> {
  if ((await getSetting("BOT_ENABLED")) !== "true") return;
  const clean = text.toLowerCase();

  const { contactId, leadId } = await matchByPhone(fromDigits);

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
    if (await withinOfficeHours()) return; // humans handle it
    const awayMsg = await getSetting("BOT_AFTERHOURS_MSG");
    if (!awayMsg) return;
    // Don't spam: one away message per customer per 4 hours
    const recent = await prisma.communication.findFirst({
      where: {
        type: "whatsapp",
        direction: "outbound",
        subject: { contains: AUTO_MARKER },
        occurredAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
        OR: [
          ...(contactId ? [{ contactId }] : []),
          ...(leadId ? [{ leadId }] : []),
          { body: { contains: fromDigits } },
        ],
      },
    });
    if (recent) return;
    reply = awayMsg;
    ruleName = "after-hours";
  }

  const sent = await sendWhatsAppText(fromDigits, reply);
  if (!sent.ok) return;

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) return;
  await prisma.communication.create({
    data: {
      type: "whatsapp",
      direction: "outbound",
      subject: `${AUTO_MARKER} (${ruleName})`,
      body: contactId || leadId ? reply : `${reply}\n\n[to +${fromDigits}]`,
      contactId,
      leadId,
      userId: firstUser.id,
    },
  });
}
