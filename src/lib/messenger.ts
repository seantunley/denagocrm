import crypto from "crypto";
import { prisma } from "./db";
import { resolveTenantCredential } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { saveFile } from "./storage";
import { resolveTenantActor } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Every outbound Graph/CDN call is bounded. Without a signal these inherit
 * Node fetch's default of no timeout, so one unresponsive Meta endpoint holds a
 * webhook handler or a cron sweep open until the platform kills it.
 */
const OUTBOUND_TIMEOUT_MS = 15_000;

/** Largest inbound DM attachment we will pull into memory. */
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export type DmPlatform = "messenger" | "instagram";

/** The tenant a Meta page-token lookup should prefer, or null (global). */
function ambientTenantId(): string | null {
  return currentTenantScope()?.tenantId ?? null;
}

export async function isMessengerConfigured(): Promise<boolean> {
  return Boolean(await resolveTenantCredential(ambientTenantId(), "META_PAGE_ACCESS_TOKEN"));
}

/**
 * The system-user token manages the page; sends need the page-scoped token.
 *
 * Tenant-keyed and fingerprint-bound already: a warm process serving tenant B
 * must not reuse tenant A's page token, and rotating or disconnecting the source
 * credential must not leave the derived token usable for the rest of the TTL.
 *
 * Two residual hazards are closed here.
 *
 * The tenant was read TWICE — once for the cache key, once for the credential
 * lookup — from a scope that a concurrent request can change between the two
 * reads. Two reads of a mutable ambient value can disagree, and when they do the
 * entry is filed under one tenant and holds another's token: the same defect the
 * keying exists to prevent, just narrower. It is read once now and both uses take
 * that value.
 *
 * And nothing ever removed an entry. A long-lived process serving many tenants
 * accumulated one live page token per tenant for the life of the process, none of
 * them reachable for eviction — so the expiry bounded how long an entry was USED,
 * not how long it was held. Expired entries are now dropped on write.
 */
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000;
const GLOBAL_TOKEN_KEY = " global";
type PageTokenCacheEntry = { token: string; sourceHash: string; fetchedAt: number };
const pageTokenCache = new Map<string, PageTokenCacheEntry>();
const sourceFingerprint = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function getPageToken(): Promise<string | null> {
  // ONCE. Both the key and the lookup below must describe the same tenant.
  const tenantId = ambientTenantId();
  const cacheKey = tenantId ?? GLOBAL_TOKEN_KEY;

  const sysToken = await resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN");
  if (!sysToken) {
    // Disconnected. Serving the derived token until the TTL lapses would keep
    // sending from a Page the workspace has just detached.
    pageTokenCache.delete(cacheKey);
    return null;
  }

  const sourceHash = sourceFingerprint(sysToken);
  const cached = pageTokenCache.get(cacheKey);
  if (cached && cached.sourceHash === sourceHash && Date.now() - cached.fetchedAt < PAGE_TOKEN_TTL_MS) {
    return cached.token;
  }

  try {
    const res = await fetch(
      `${GRAPH}/me/accounts?fields=id,access_token&access_token=${encodeURIComponent(sysToken)}`,
      { cache: "no-store", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const token: string | undefined = json.data?.[0]?.access_token;
    if (!token) return null;
    const now = Date.now();
    // Drop expired entries on write so a long-lived process serving many tenants
    // does not hold one page token per tenant for ever.
    for (const [key, entry] of pageTokenCache) {
      if (now - entry.fetchedAt >= PAGE_TOKEN_TTL_MS) pageTokenCache.delete(key);
    }
    pageTokenCache.set(cacheKey, { token, sourceHash, fetchedAt: now });
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
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
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
    const res = await fetch(att.url, { cache: "no-store", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
    if (!res.ok) return null;
    // The 20MB cap used to be applied AFTER arrayBuffer(), i.e. after the whole
    // response was already resident — which is not a cap, it is a report. Check
    // the declared length first, then enforce it per chunk while reading, because
    // a Content-Length is a claim and a stream is a fact.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) return null;
    if (!res.body) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > ATTACHMENT_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
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
      { cache: "no-store", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
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
      // Through the one lead creator. This used to be a bare prisma.lead.create
      // plus an audit line: an ad-attributed Facebook/Instagram lead fired NO
      // `lead_created` automations and raised no "New lead" push, and — because
      // it never set `position` while topPosition hands out DECREASING numbers —
      // it landed underneath every lead that came in through the web form.
      const label = platform === "instagram" ? "Instagram" : "Facebook";
      const who = `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}`;
      const title = `${label} ad enquiry — ${who}`;
      // …IfPipelineReady keeps the old `if (firstStage)` guard: with no pipeline
      // configured the DM is still filed against the contact below.
      const lead = await createLeadRecordIfPipelineReady({
        title,
        name: who,
        source: platform === "instagram" ? "instagram" : "facebook",
        contactId: contact.id,
        notes: [
          "Started a DM conversation from an ad.",
          referral.ad_id ? `Ad ID: ${referral.ad_id}` : null,
          referral.ref ? `Ref: ${referral.ref}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        audit: {
          action: "lead.received",
          summary: `Lead “${title}” created — DM conversation started from an ad`,
          userName: "System",
        },
      });
      if (lead) leadId = lead.id;
    }
  }

  const firstUser = await resolveTenantActor(); // tenant-aware (channel scope); dormant → oldest active user
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
    const { reopenThreadOnInbound } = await import("@/lib/reopenThread");
    await reopenThreadOnInbound(contact.id, leadId, platform);
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
  const firstUser = await resolveTenantActor(); // tenant-aware (channel scope); dormant → oldest active user
  if (!firstUser) return;

  // An outbound echo must not resurrect a deliberately-archived thread. The
  // newest existing row decides the thread's state (matching buildInboxThreads'
  // grouping): if it's archived, stamp the echo archived too so the whole thread
  // stays in Archived instead of splitting into a lone active message. Inbound
  // messages still reopen the thread via reopenThreadOnInbound — unchanged.
  const latest = await prisma.communication.findFirst({
    where: { type: platform, contactId: contact.id },
    orderBy: { occurredAt: "desc" },
    select: { archivedAt: true },
  });

  await prisma.communication.create({
    data: {
      type: platform,
      direction: "outbound",
      body: text,
      contactId: contact.id,
      userId: firstUser.id,
      archivedAt: latest?.archivedAt ?? null,
    },
  });
}
