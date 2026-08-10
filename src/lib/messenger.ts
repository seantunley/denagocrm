import { Prisma } from "@prisma/client";
import { decideEcho } from "./metaEcho";
import { deleteCommunicationsAndReconcile } from "./conversations";
import { prisma } from "./db";
import { resolveTenantCredential } from "./settings";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { inboundCommunicationKey, isDedupeKeyConflict } from "./inboundMessageKey";
import { currentInboundBotEventId } from "./botInboundEvent";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { saveFile } from "./storage";
import { resolveTenantActor } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";
import { DerivedCredentialCache } from "./derivedCredentialCache";

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
 * Every rule about WHOSE token this is and WHETHER it is still derivable lives in
 * DerivedCredentialCache, where it can be exercised directly. What is left here
 * is the part specific to Meta: which credential the page token is derived from,
 * and how the exchange is made.
 *
 * Note the shape. The tenant is read ONCE and feeds both the key and the
 * credential lookup — two reads of a mutable ambient scope can disagree, and when
 * they do the entry is filed under one tenant holding another's token. And the
 * source credential is resolved BEFORE the cache is reachable at all, because it
 * is an argument: a rotation or a disconnect cannot be short-circuited by a hit.
 */
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000;
const GLOBAL_TOKEN_KEY = " global";
const pageTokenCache = new DerivedCredentialCache<string>({ ttlMs: PAGE_TOKEN_TTL_MS });

/** Exchange a system-user token for the page-scoped one. Null on any failure. */
async function exchangeForPageToken(sysToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${GRAPH}/me/accounts?fields=id,access_token&access_token=${encodeURIComponent(sysToken)}`,
      { cache: "no-store", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0]?.access_token ?? null;
  } catch {
    return null;
  }
}

async function getPageToken(): Promise<string | null> {
  // ONCE. Both the key and the lookup below must describe the same tenant.
  const tenantId = ambientTenantId();
  const sysToken = await resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN");
  return pageTokenCache.resolve(tenantId ?? GLOBAL_TOKEN_KEY, sysToken, exchangeForPageToken);
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
  attachments: InboundAttachment[] = [],
  /** The provider's message id (mid), so a redelivery reuses these rows. */
  providerMessageId?: string,
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

  // One identity for this provider event, shared by the text row and every
  // attachment row. See inboundMessageKey: the ledger row id is globally unique,
  // so the transcript's boundary matches the ledger's exactly.
  const identity = {
    ledgerEventId: currentInboundBotEventId(),
    tenantId: writeTenantId() ?? DEFAULT_TENANT_ID,
    channel: platform,
    providerId: providerMessageId ?? "",
  };
  // "Nothing new was written" — NOT "some row was a duplicate". A retry where the
  // text already existed but a missing attachment is newly inserted HAS produced
  // something the inbox should announce.
  let insertedAny = false;
  const firstUser = await resolveTenantActor(); // tenant-aware (channel scope); dormant → oldest active user
  if (firstUser) {
    if (text) {
      // create(), NOT createMany(): db.ts hooks communication.create to resolve
      // and attach the Conversation and bump its counters. There is no createMany
      // hook, and the whole inbox collaboration layer hangs off Conversation rows.
      const key = inboundCommunicationKey(identity);
      try {
        await prisma.communication.create({
          data: {
            type: platform,
            direction: "inbound",
            body: text,
            contactId: contact.id,
            leadId,
            userId: firstUser.id,
            ...(key ? { dedupeKey: key } : {}),
          },
        });
        insertedAny = true;
      } catch (error) {
        if (!key || !isDedupeKeyConflict(error)) throw error;
      }
    }
    // Media becomes one communication per attachment, stored permanently
    for (const [index, att] of attachments.slice(0, 5).entries()) {
      const attKey = inboundCommunicationKey(identity, index);
      // Check BEFORE downloading. persistAttachment writes permanent storage under
      // a fresh random object name every call, so persisting first and deduping
      // afterwards left an orphaned blob for every redelivery — the transcript was
      // clean and the bucket was not. Attachments are explicitly part of this
      // dedupe contract, so the cheap read comes first.
      if (attKey && (await prisma.communication.findUnique({ where: { dedupeKey: attKey }, select: { id: true } }))) {
        continue;
      }
      const saved = await persistAttachment(att);
      try {
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
            ...(attKey ? { dedupeKey: attKey } : {}),
          },
        });
        insertedAny = true;
      } catch (error) {
        // Lost a race with a concurrent redelivery between the check and the
        // insert. The blob is already written; the transcript stays single.
        if (!attKey || !isDedupeKeyConflict(error)) throw error;
      }
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
  // Notify only when this delivery actually added something. A pure redelivery
  // must not buzz everyone again; a retry that finally lands a missing attachment
  // legitimately should. Note this is "nothing new was written", which is a
  // near-proxy for "already notified" rather than proof of it — a durable
  // notification identity would be the exact answer, and is not worth its own
  // table for a push.
  if (!insertedAny) return;
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
  /**
   * `create`, never `upsert`, and the idempotency comes from catching the
   * conflict instead.
   *
   * This mattered more than it looks. The guarded client intercepts
   * `Communication.create` — and ONLY create — to attach the row to its
   * conversation and roll that conversation's counters forward. An upsert
   * silently skipped both: the echo landed with `conversationId: null`, outside
   * the threading every conversation-scoped query depends on, while looking
   * perfectly fine on the timeline. Measured, not assumed.
   */
  let written: { id: string };
  try {
    written = await prisma.communication.create({
      data: decision.dedupeKey ? { ...data, dedupeKey: decision.dedupeKey } : data,
      select: { id: true },
    });
  } catch (error) {
    // Meta redelivers webhooks. The unique dedupeKey is what makes the second
    // delivery a no-op rather than a third copy of the customer's message.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }

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
    // Not a bare delete. The create above rolled this conversation's counters
    // forward, and nothing intercepts a delete — so removing only the row would
    // leave the transcript right and the projection one message ahead for ever.
    await deleteCommunicationsAndReconcile({ id: written.id });
  }
}
