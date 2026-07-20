import { prisma } from "./db";
import { getSetting } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { saveFile } from "./storage";

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

/** Sends a DM with tappable quick-reply chips (menu options). */
export async function sendDirectQuickReplies(
  platform: DmPlatform,
  recipientId: string,
  text: string,
  replies: { title: string; payload: string }[]
): Promise<{ ok: boolean; error?: string }> {
  const token = await getPageToken();
  if (!token) return { ok: false, error: "Meta page token is not configured." };
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: {
        text,
        quick_replies: replies.slice(0, 11).map((r) => ({
          content_type: "text",
          title: r.title.slice(0, 20),
          payload: r.payload.slice(0, 1000),
        })),
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { ok: false, error: err?.error?.message ?? `Send API error ${res.status}` };
  }
  return { ok: true };
}

/** Sends an image / audio / video / file attachment by URL. */
export async function sendDirectAttachment(
  platform: DmPlatform,
  recipientId: string,
  attachment: { type: "image" | "audio" | "video" | "file"; url: string }
): Promise<{ ok: boolean; error?: string }> {
  const token = await getPageToken();
  if (!token) return { ok: false, error: "Meta page token is not configured (Settings → Integrations)." };
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: {
        attachment: { type: attachment.type, payload: { url: attachment.url, is_reusable: false } },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { ok: false, error: err?.error?.message ?? `Send API error ${res.status}` };
  }
  return { ok: true };
}

export type InboundAttachment = { type: string; url: string };

const ATTACHMENT_EXT: Record<string, string> = {
  image: ".jpg",
  audio: ".mp4",
  video: ".mp4",
  file: ".bin",
};

/**
 * Meta's attachment URLs expire, so pull the media down into our own storage
 * and keep a permanent link. Returns null if the download fails.
 */
async function persistAttachment(
  att: InboundAttachment
): Promise<{ url: string; type: string } | null> {
  try {
    const res = await fetch(att.url, { cache: "no-store" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 20 * 1024 * 1024) return null; // 20MB cap
    const kind = ["image", "audio", "video", "file"].includes(att.type) ? att.type : "file";
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const url = await saveFile(buf, `dm-${kind}${ATTACHMENT_EXT[kind]}`, contentType);
    return { url, type: kind };
  } catch {
    return null;
  }
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
  referral: Referral,
  attachments: InboundAttachment[] = []
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
    if (text) {
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
    // Media becomes one communication per attachment, stored permanently
    for (const att of attachments.slice(0, 5)) {
      const saved = await persistAttachment(att);
      await prisma.communication.create({
        data: {
          type: platform,
          direction: "inbound",
          body: saved
            ? saved.type === "audio"
              ? "🎤 Voice note"
              : saved.type === "image"
              ? "🖼 Image"
              : saved.type === "video"
              ? "🎬 Video"
              : "📎 File"
            : `[${att.type} attachment — could not be saved]`,
          attachmentUrl: saved?.url ?? null,
          attachmentType: saved?.type ?? null,
          contactId: contact.id,
          leadId,
          userId: firstUser.id,
        },
      });
    }
  }
  const pushBody =
    text ||
    (attachments[0]
      ? attachments[0].type === "audio"
        ? "🎤 sent a voice note"
        : `sent a ${attachments[0].type}`
      : "sent a message");
  await sendPushToAll({
    title: platform === "instagram" ? "New Instagram DM 📸" : "New Messenger message 🔵",
    body: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}: ${pushBody.slice(0, 80)}`,
    url: "/messages",
  }, "dm").catch(() => {});
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
