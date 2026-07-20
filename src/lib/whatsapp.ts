import { prisma } from "./db";
import { getSetting } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { topPosition } from "./leadPos";

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

/** Sends an image by URL (e.g. a brochure) on WhatsApp. */
export async function sendWhatsAppImage(toDigits: string, url: string, caption?: string): Promise<{ ok: boolean; error?: string }> {
  const [phoneNumberId, token] = await Promise.all([getSetting("WA_PHONE_NUMBER_ID"), getSetting("WA_ACCESS_TOKEN")]);
  if (!phoneNumberId || !token) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "image", image: { link: url, ...(caption ? { caption } : {}) } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { ok: false, error: err?.error?.message ?? `WhatsApp API error ${res.status}` };
  }
  return { ok: true };
}

async function sendInteractive(toDigits: string, interactive: unknown): Promise<{ ok: boolean; error?: string }> {
  const [phoneNumberId, token] = await Promise.all([
    getSetting("WA_PHONE_NUMBER_ID"),
    getSetting("WA_ACCESS_TOKEN"),
  ]);
  if (!phoneNumberId || !token) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "interactive", interactive }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { ok: false, error: err?.error?.message ?? `WhatsApp API error ${res.status}` };
  }
  return { ok: true };
}

/** Sends up to 3 tappable reply buttons. */
export async function sendWhatsAppButtons(
  toDigits: string,
  body: string,
  buttons: { id: string; title: string }[]
) {
  return sendInteractive(toDigits, {
    type: "button",
    body: { text: body.slice(0, 1024) },
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({
        type: "reply",
        reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
      })),
    },
  });
}

/** Sends a tappable list (up to 10 rows) behind a menu button. */
export async function sendWhatsAppList(
  toDigits: string,
  body: string,
  buttonLabel: string,
  rows: { id: string; title: string; description?: string }[]
) {
  return sendInteractive(toDigits, {
    type: "list",
    body: { text: body.slice(0, 1024) },
    action: {
      button: buttonLabel.slice(0, 20),
      sections: [
        {
          rows: rows.slice(0, 10).map((r) => ({
            id: r.id.slice(0, 200),
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        },
      ],
    },
  });
}

/** Downloads a WhatsApp media object (e.g. a voice note) by its media id. */
export async function fetchWhatsAppMedia(
  mediaId: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const token = await getSetting("WA_ACCESS_TOKEN");
  if (!token) return null;
  try {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta.url) return null;
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!fileRes.ok) return null;
    return {
      buffer: Buffer.from(await fileRes.arrayBuffer()),
      contentType: meta.mime_type ?? fileRes.headers.get("content-type") ?? "audio/ogg",
    };
  } catch {
    return null;
  }
}

/** Logs an inbound WhatsApp message against the right customer record. */
export async function recordInboundWhatsApp(
  fromDigits: string,
  profileName: string | null,
  text: string
) {
  const match = await matchByPhone(fromDigits);
  const { contactId } = match;
  let { leadId } = match;

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
          position: await topPosition(firstStage.id),
        },
      });
      leadId = lead.id;
      await logAudit({
        action: "lead.received",
        summary: `Lead “${lead.title}” created from inbound WhatsApp`,
        leadId,
        userName: "System",
      });
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

  // Notify on every inbound — WhatsApp is the primary contact channel. Opens the
  // Messages app so replies aren't lost in the CRM.
  await sendPushToAll({
    title: "New WhatsApp message 💬",
    body: `${profileName ?? "+" + fromDigits}: ${text.slice(0, 80)}`,
    url: "/messages",
  }, "whatsapp").catch(() => {});
}
