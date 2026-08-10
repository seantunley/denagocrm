import crypto from "crypto";
import { prisma } from "./db";
import { resolveTenantCredential } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { saveFile } from "./storage";
import { resolveTenantActor } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";
import { writeTenantId } from "./tenantWrite";
import { DEFAULT_TENANT_ID } from "./tenant";
import { decideEcho } from "./metaEcho";

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
 * This cache used to be ONE module-global token. A warm server process serving
 * tenant B within 30 minutes of tenant A could therefore reuse A's page token.
 * Cache by tenant and bind the entry to a fingerprint of the current source
 * credential so rotating a token invalidates the cached derived page token too.
 */
type PageTokenCacheEntry = { token: string; sourceHash: string; fetchedAt: number };
const pageTokenCache = new Map<string, PageTokenCacheEntry>();
const tokenHash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function getPageToken(): Promise<string | null> {
  const tenantKey = ambientTenantId() ?? "__global__";
  const sysToken = await resolveTenantCredential(ambientTenantId(), "META_PAGE_ACCESS_TOKEN");
  if (!sysToken) {
    pageTokenCache.delete(tenantKey);
    return null;
  }
  const sourceHash = tokenHash(sysToken);
  const cached = pageTokenCache.get(tenantKey);
  if (cached && cached.sourceHash === sourceHash && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
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
    pageTokenCache.set(tenantKey, { token, sourceHash, fetchedAt: Date.now() });
    return token;
  } catch {
    return null;
  }
}

/**
 * The outcome of a Meta send.
 *
 * `providerMessageId` is Meta's own id for the accepted message, and it is the
 * only thing that can later identify the echo of THIS send among the echoes of
 * every message the Page has ever sent. Every sender must return it: an echo the
 * ledger cannot recognise is written into the customer's history a second time.
 */
export type MetaSendResult = { ok: boolean; error?: string; providerMessageId?: string };

/**
 * Every Meta send is the same POST to the same endpoint, and the reply carries
 * the same `message_id`. They were three separate functions each parsing their
 * own response, and only ONE of them was ever taught to keep that id — so a
 * plain text reply could be recognised as our own echo and the identical text
 * sent with quick-reply chips could not, for no reason a reader could see.
 *
 * One call site now, so "keep the id" is not a thing a future sender can forget
 * to do. `humanise` is the only per-sender difference: turning Meta's wording for
 * the 24-hour window and for pending app review into something a salesperson can
 * act on.
 */
async function postToSendApi(
  message: unknown,
  recipientId: string,
  humanise: (message: string) => string = (message) => message,
): Promise<MetaSendResult> {
  const token = await getPageToken();
  if (!token) return { ok: false, error: "Meta page token is not configured (Settings → Integrations)." };
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { ok: false, error: humanise(err?.error?.message ?? `Send API error ${res.status}`) };
  }
  const accepted = await res.json().catch(() => null);
  return {
    ok: true,
    providerMessageId: typeof accepted?.message_id === "string" ? accepted.message_id : undefined,
  };
}

/** Meta's send errors, in words a salesperson can act on. */
function humaniseSendError(message: string): string {
  if (/24|window|outside/i.test(message)) {
    return "Outside the 24-hour reply window — the customer must message you first.";
  }
  if (/permission|OAuth/i.test(message)) {
    return `Meta hasn't approved messaging permissions yet (app review pending): ${message}`;
  }
  return message;
}

/** Sends a Messenger / Instagram DM (24-hour customer-service window applies). */
export async function sendDirectMessage(
  platform: DmPlatform,
  recipientId: string,
  text: string
): Promise<MetaSendResult> {
  return postToSendApi({ text }, recipientId, humaniseSendError);
}

/** Sends a DM with tappable quick-reply chips (menu options). */
export async function sendDirectQuickReplies(
  platform: DmPlatform,
  recipientId: string,
  text: string,
  replies: { title: string; payload: string }[]
): Promise<MetaSendResult> {
  return postToSendApi(
    {
      text,
      quick_replies: replies.slice(0, 11).map((r) => ({
        content_type: "text",
        title: r.title.slice(0, 20),
        payload: r.payload.slice(0, 1000),
      })),
    },
    recipientId,
    humaniseSendError,
  );
}

/** Sends an image / audio / video / file attachment by URL. */
export async function sendDirectAttachment(
  platform: DmPlatform,
  recipientId: string,
  attachment: { type: "image" | "audio" | "video" | "file"; url: string }
): Promise<MetaSendResult> {
  return postToSendApi(
    { attachment: { type: attachment.type, payload: { url: attachment.url, is_reusable: false } } },
    recipientId,
    humaniseSendError,
  );
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

/** Does an outbox row already hold this provider id? The one unambiguous answer. */
async function ledgerHoldsProviderId(tenantId: string, providerMessageId: string): Promise<boolean> {
  return Boolean(
    await prisma.botFlowOutbox.findFirst({
      where: { tenantId, providerMessageId },
      select: { id: true },
    }),
  );
}

export async function recordDmEcho(
  platform: DmPlatform,
  recipientId: string,
  text: string,
  providerMessageId?: string | null,
) {
  // Scoped, or one tenant's send would suppress another tenant's echo.
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const decision = decideEcho({
    tenantId,
    providerMessageId,
    ledgerHasId: providerMessageId ? await ledgerHoldsProviderId(tenantId, providerMessageId) : false,
  });
  if (decision.action === "drop") return;

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

  const data = {
    type: platform,
    direction: "outbound",
    body: text,
    contactId: contact.id,
    userId: firstUser.id,
    archivedAt: latest?.archivedAt ?? null,
    // The provider's own id travels WITH the row. It is what lets the worker
    // recognise this as its own message later, and what makes a redelivered
    // webhook a no-op rather than a third copy.
    messageId: providerMessageId ?? null,
  };
  const written = decision.dedupeKey
    ? await prisma.communication.upsert({
        where: { dedupeKey: decision.dedupeKey },
        update: {},
        create: { ...data, dedupeKey: decision.dedupeKey },
        select: { id: true },
      })
    : await prisma.communication.create({ data, select: { id: true } });

  if (!providerMessageId) return;

  /**
   * THE INTERLEAVING THIS CLOSES.
   *
   * The ledger check above ran before the worker committed the id; this write
   * landed after the worker's own cleanup had already looked and found nothing.
   * Neither side is at fault and the duplicate would simply stay.
   *
   * So the answer is re-read after writing. Whichever of the two commits second
   * removes the duplicate, and the row is only ever deleted on PROOF — an outbox
   * row holding this exact id — never on a resemblance.
   */
  if (await ledgerHoldsProviderId(tenantId, providerMessageId)) {
    await prisma.communication.deleteMany({ where: { id: written.id } });
  }
}
