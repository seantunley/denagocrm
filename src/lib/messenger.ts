import { prisma } from "./db";
import { getSetting } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";

const GRAPH = "https://graph.facebook.com/v21.0";

export type DmPlatform = "messenger" | "instagram";

export async function isMessengerConfigured(): Promise<boolean> {
  return Boolean(await getSetting("META_PAGE_ACCESS_TOKEN"));
}

/** The system-user token manages the page; sends need the page-scoped token. */
let cachedPageToken: { token: string; fetchedAt: number } | null = null;
async function getPageToken(): Promise<string | null> {
  if (cachedPageToken && Date.now() - cachedPageToken.fetchedAt < 30 * 60 * 1000) {
    return cachedPageToken.token;
  }
  const sysToken = await getSetting("META_PAGE_ACCESS_TOKEN");
  if (!sysToken) return null;
  try {
    const res = await fetch(
      `${GRAPH}/me/accounts?fields=id,access_token&access_token=${encodeURIComponent(sysToken)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const token: string | undefined = json.data?.[0]?.access_token;
    if (!token) return null;
    cachedPageToken = { token, fetchedAt: Date.now() };
    return token;
  } catch {
    return null;
  }
}

/** Sends a Messenger / Instagram DM (24-hour customer-service window applies). */
export async function sendDirectMessage(
  platform: DmPlatform,
  recipientId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const token = await getPageToken();
  if (!token) return { ok: false, error: "Meta page token is not configured (Settings → Integrations)." };
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const msg: string = err?.error?.message ?? `Send API error ${res.status}`;
    const friendly = /24|window|outside/i.test(msg)
      ? "Outside the 24-hour reply window — the customer must message you first."
      : /permission|OAuth/i.test(msg)
      ? `Meta hasn't approved messaging permissions yet (app review pending): ${msg}`
      : msg;
    return { ok: false, error: friendly };
  }
  return { ok: true };
}

async function fetchProfileName(platform: DmPlatform, userId: string): Promise<string | null> {
  const token = await getPageToken();
  if (!token) return null;
  try {
    const fields = platform === "instagram" ? "name,username" : "first_name,last_name";
    const res = await fetch(
      `${GRAPH}/${userId}?fields=${fields}&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const j = await res.json();
    if (platform === "instagram") return j.name ?? j.username ?? null;
    return [j.first_name, j.last_name].filter(Boolean).join(" ") || null;
  } catch {
    return null;
  }
}

type Referral = { ref?: string; ad_id?: string; source?: string; type?: string } | null;

/**
 * Inbound DM → the customer's record:
 *  - known DM identity → just log the communication
 *  - unknown → create a contact (all future messages bundle there)
 *  - arrived via an ad (referral) → also open a lead on that contact
 */
export async function recordInboundDm(
  platform: DmPlatform,
  senderId: string,
  text: string,
  referral: Referral
) {
  const idField = platform === "instagram" ? "instagramId" : "messengerPsid";
  let contact = await prisma.contact.findFirst({ where: { [idField]: senderId } });

  if (!contact) {
    const profileName = await fetchProfileName(platform, senderId);
    const label = platform === "instagram" ? "Instagram" : "Messenger";
    const [firstName, ...rest] = (profileName ?? `${label} user`).split(/\s+/);
    contact = await prisma.contact.create({
      data: {
        firstName: firstName || label,
        lastName: rest.join(" ") || null,
        source: platform,
        [idField]: senderId,
        notes: profileName ? null : `Created from an inbound ${label} DM — name not yet available.`,
      },
    });
    await logAudit({
      action: "contact.created",
      summary: `Contact created from an inbound ${label} DM`,
      contactId: contact.id,
      userName: "System",
    });
  }

  // Ad-attributed conversation → make sure there's an open lead
  let leadId: string | null = null;
  if (referral) {
    const openLead = await prisma.lead.findFirst({
      where: { contactId: contact.id, status: "open" },
    });
    if (openLead) {
      leadId = openLead.id;
    } else {
      const firstStage = await prisma.pipelineStage.findFirst({ orderBy: { order: "asc" } });
      if (firstStage) {
        const label = platform === "instagram" ? "Instagram" : "Facebook";
        const lead = await prisma.lead.create({
          data: {
            title: `${label} ad enquiry — ${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}`,
            name: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}`,
            source: platform === "instagram" ? "instagram" : "facebook",
            stageId: firstStage.id,
            contactId: contact.id,
            notes: [
              "Started a DM conversation from an ad.",
              referral.ad_id ? `Ad ID: ${referral.ad_id}` : null,
              referral.ref ? `Ref: ${referral.ref}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        });
        leadId = lead.id;
        await logAudit({
          action: "lead.received",
          summary: `Lead “${lead.title}” created — DM conversation started from an ad`,
          leadId,
          contactId: contact.id,
          userName: "System",
        });
      }
    }
  }

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (firstUser) {
    await prisma.communication.create({
      data: {
        type: platform,
        direction: "inbound",
        body: text,
        contactId: contact.id,
        leadId,
        userId: firstUser.id,
      },
    });
  }
  await sendPushToAll({
    title: platform === "instagram" ? "New Instagram DM 📸" : "New Messenger message 🔵",
    body: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}: ${text.slice(0, 80)}`,
    url: `/contacts/${contact.id}`,
  }).catch(() => {});
}

/** Replies sent from Business Suite / the phone app arrive as echoes — file them too. */
export async function recordDmEcho(platform: DmPlatform, recipientId: string, text: string) {
  const idField = platform === "instagram" ? "instagramId" : "messengerPsid";
  const contact = await prisma.contact.findFirst({ where: { [idField]: recipientId } });
  if (!contact) return;
  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) return;
  await prisma.communication.create({
    data: {
      type: platform,
      direction: "outbound",
      body: text,
      contactId: contact.id,
      userId: firstUser.id,
    },
  });
}
