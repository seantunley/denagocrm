import { prisma } from "./db";
import { getSetting } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Normalises a phone number to WhatsApp digits (27…). */
export function waDigits(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0")) d = "27" + d.slice(1);
  return d;
}

export async function isWhatsAppConfigured(): Promise<boolean> {
  const [id, token] = await Promise.all([
    getSetting("WA_PHONE_NUMBER_ID"),
    getSetting("WA_ACCESS_TOKEN"),
  ]);
  return Boolean(id && token);
}

/** Finds the contact (or open lead) a WhatsApp number belongs to. */
export async function matchByPhone(digits: string) {
  const variants = [digits, "0" + digits.slice(2), "+" + digits];
  const contacts = await prisma.contact.findMany({
    where: {
      OR: variants.flatMap((v) => [
        { phone: { contains: v.slice(-9) } },
        { whatsapp: { contains: v.slice(-9) } },
      ]),
    },
    take: 1,
  });
  if (contacts[0]) return { contactId: contacts[0].id, leadId: null as string | null };
  const lead = await prisma.lead.findFirst({
    where: { phone: { contains: digits.slice(-9) }, status: "open" },
  });
  return { contactId: lead?.contactId ?? null, leadId: lead?.id ?? null };
}

/**
 * Sends a WhatsApp text message via the Cloud API. Works inside the 24-hour
 * customer-service window (i.e. after the customer messaged you).
 */
export async function sendWhatsAppText(
  toDigits: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const [phoneNumberId, token] = await Promise.all([
    getSetting("WA_PHONE_NUMBER_ID"),
    getSetting("WA_ACCESS_TOKEN"),
  ]);
  if (!phoneNumberId || !token) {
    return { ok: false, error: "WhatsApp is not configured (Settings → Integrations)." };
  }
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const msg: string = err?.error?.message ?? `WhatsApp API error ${res.status}`;
    const friendly = msg.includes("24")
      ? "Outside the 24-hour reply window — the customer must message you first (or use an approved template from WhatsApp Manager)."
      : msg;
    return { ok: false, error: friendly };
  }
  return { ok: true };
}

/** Logs an inbound WhatsApp message against the right customer record. */
export async function recordInboundWhatsApp(
  fromDigits: string,
  profileName: string | null,
  text: string
) {
  const match = await matchByPhone(fromDigits);
  let { contactId, leadId } = match;

  // unknown number → create a lead so nothing is lost
  if (!contactId && !leadId) {
    const firstStage = await prisma.pipelineStage.findFirst({ orderBy: { order: "asc" } });
    if (firstStage) {
      const lead = await prisma.lead.create({
        data: {
          title: `WhatsApp enquiry — ${profileName ?? fromDigits}`,
          name: profileName ?? `WhatsApp ${fromDigits}`,
          phone: "+" + fromDigits,
          source: "whatsapp",
          stageId: firstStage.id,
        },
      });
      leadId = lead.id;
      await logAudit({
        action: "lead.received",
        summary: `Lead “${lead.title}” created from inbound WhatsApp`,
        leadId,
        userName: "System",
      });
      await sendPushToAll({
        title: "New WhatsApp lead 💬",
        body: `${profileName ?? fromDigits}: ${text.slice(0, 80)}`,
        url: `/leads/${leadId}`,
      }, "whatsapp").catch(() => {});
    }
  }

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) return;
  await prisma.communication.create({
    data: {
      type: "whatsapp",
      direction: "inbound",
      body: text,
      contactId,
      leadId,
      userId: firstUser.id,
    },
  });
}
