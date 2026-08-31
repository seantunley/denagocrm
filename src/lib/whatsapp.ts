import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "./db";
import { logAudit } from "./audit";
import { activeTenantPredicate } from "./tenantPredicate";
import { PHONE_TAIL_SQL, phoneTail } from "./phoneMatch";
import {
  WA_BODY_MAX,
  WA_BUTTON_MAX,
  WA_BUTTON_TITLE_MAX,
  WA_LIST_BUTTON_MAX,
  WA_LIST_DESCRIPTION_MAX,
  WA_LIST_ROW_MAX,
  WA_LIST_TITLE_MAX,
  WA_TEXT_MAX,
} from "./whatsappRendering";
import { customerRecordTenantId } from "./customerRecordTenant";
import { credentialOwnerTenantId, resolveIntegrationBundleForTenant, resolveTenantCredential } from "./settings";
import { sendPushToAll } from "./push";
import { resolveTenantActor } from "./tenantActor";
import { inboundCommunicationKey, isDedupeKeyConflict } from "./inboundMessageKey";
import { currentInboundBotEventId } from "./botInboundEvent";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { currentTenantScope } from "./tenantScope";
import { distinctIdentities } from "./botBookingIdentity";

/**
 * Every outbound call is bounded. Node fetch has NO default timeout, so an
 * unresponsive provider holds a webhook handler or a cron sweep open until the
 * platform kills the whole invocation.
 */
const OUTBOUND_TIMEOUT_MS = 15_000;

const GRAPH = "https://graph.facebook.com/v21.0";

/** The tenant a WhatsApp credential lookup should prefer, or null (global). */
function ambientTenantId(): string | null {
  return currentTenantScope()?.tenantId ?? null;
}

/**
 * The credentials for one WhatsApp call, WITH the tenant they were resolved for.
 *
 * The tenant travels with the credentials because it cannot be recovered
 * afterwards: request tenant scope is a no-op while enforcement is off, so
 * asking `currentTenantScope()` a second time — inside the send-health hook —
 * answers null on a normal user-triggered send and the health report is
 * discarded. `credentialOwnerTenantId` restates the fallback the credential
 * lookup itself just applied, so this is the tenant whose badge these
 * credentials are behind.
 */
type WhatsAppCredentials = {
  tenantId: string;
  /**
   * Empty ONLY on the media-read path, whose Graph endpoint is addressed by
   * media id rather than by the phone number — see fetchWhatsAppMedia, which
   * never reports a failure that would quote it.
   */
  phoneNumberId: string;
  token: string;
};

/** Resolves the phone-number id + access token, honouring a tenant override. */
async function waCredentials(): Promise<WhatsAppCredentials | null> {
  const bundle = await resolveIntegrationBundleForTenant(ambientTenantId(), "whatsapp");
  if (!bundle) return null;
  const phoneNumberId = bundle.values.WA_PHONE_NUMBER_ID;
  const token = bundle.values.WA_ACCESS_TOKEN;
  if (!phoneNumberId || !token) return null;
  return { tenantId: bundle.tenantId, phoneNumberId, token };
}

/**
 * Reports how a real send went to this tenant's integration connection state,
 * so an expired or revoked WA_ACCESS_TOKEN surfaces as "Reconnect needed" in
 * Settings → Integration overrides instead of quietly failing every message.
 *
 * Reuses the SAME classifier the guided setup's connection test uses
 * (classifyGraphError), so a token Meta rejects mid-flight is described to the
 * owner in exactly the words the setup wizard would have used, and is blamed on
 * the same flow step.
 *
 * EVERY call in this file that presents the access token reports through here —
 * text, image, audio, media upload, interactive and the media read. They share
 * one credential, so instrumenting only text meant a token that expired while a
 * tenant happened to be sending brochures and voice notes went on reading
 * "Connected" indefinitely.
 *
 * AWAITED, not fired and forgotten. `noteIntegrationSendOutcome` hands the write
 * to the platform's post-response mechanism, so awaiting it costs a registration
 * and not a database round trip inside a request; outside one it runs the write
 * to completion rather than letting the invocation end on top of it. Errors are
 * swallowed at both layers: bookkeeping must never change a send's result. Only
 * auth-class failures flip the status — see REAUTH_FAILURE_CODES.
 */
async function noteWhatsAppOutcome(
  creds: WhatsAppCredentials,
  res: { ok: boolean; status: number },
  body: unknown,
): Promise<void> {
  try {
    const [{ noteIntegrationSendOutcome }, { classifyGraphError }] = await Promise.all([
      import("./integrationConnection"),
      import("./integrationProbe"),
    ]);
    if (res.ok) {
      await noteIntegrationSendOutcome(creds.tenantId, "whatsapp", { ok: true });
      return;
    }
    const failure = classifyGraphError(res.status, body, {
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.token,
    });
    await noteIntegrationSendOutcome(creds.tenantId, "whatsapp", { ok: false, failure }, [creds.token]);
  } catch {
    /* bookkeeping must never break a send */
  }
}

/** Normalises a phone number to WhatsApp digits (27…). */
export function waDigits(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0")) d = "27" + d.slice(1);
  return d;
}

export async function isWhatsAppConfigured(): Promise<boolean> {
  return (await waCredentials()) !== null;
}

/**
 * Finds the contact (or open lead) a WhatsApp number belongs to.
 *
 * This is the CHANNEL identity the booking self-service boundary trusts — see
 * botBookingIdentity.ts, which exists because a typed phone number is a claim and
 * not proof. That boundary is only as good as this lookup, and this lookup had
 * two ways to name the wrong person:
 *
 *   * `contains` matched the 9-digit tail ANYWHERE in the stored value, not at the
 *     end. A field holding two numbers, an extension, or a longer string matches a
 *     tail that is not its own.
 *   * `take: 1` with NO `orderBy`. With more than one match Postgres returns
 *     whichever row it likes, so the same inbound number could resolve to
 *     different customers on different requests — and while enforcement is dormant
 *     `withChannelTenantScope` adds no tenant predicate, so "more than one match"
 *     includes another workspace's customer.
 *
 * Matching the DIGIT TAIL is what was meant. The ordering makes the pick
 * deterministic. And `ambiguous` reports what a single row cannot: that the number
 * did not identify ONE person. Ordinary conversation still uses the deterministic
 * pick — an inbound message must be filed somewhere — but an action that touches an
 * existing booking refuses it, because "probably this customer" is not identity.
 *
 * Ambiguity is counted ACROSS both tables. Returning as soon as a Contact matched
 * meant one Contact and one unrelated open Lead on the same number read as
 * unambiguous, and that is two people. A Lead pointing AT a matched Contact is the
 * same person, so identities collapse on contactId rather than on row count.
 *
 * Which is exactly why the candidate query cannot be truncated to two rows. Rows
 * are not identities: two Leads both pointing at the matched Contact fill both
 * slots and are ONE person, hiding a third row that is somebody else. The query
 * takes a generous bound instead, and REACHING that bound is itself ambiguous —
 * at that point the lookup cannot prove the number names one person, which is the
 * same answer as proving it names two.
 *
 * FIXED, and it was the biggest of the three: CRM phone fields are free-form, and
 * both `contains` and `endsWith` needed a CONTIGUOUS digit run — so "082 123 4567"
 * never matched the same person arriving as +27821234567, and the CRM filed a
 * second record for a customer it already had. Non-digits are stripped before
 * comparing now (phoneMatch.ts), and migration 82 indexes that same expression so
 * the lookup stays a single index probe rather than a table scan.
 */
export type PhoneMatch = { contactId: string | null; leadId: string | null; ambiguous: boolean };

/**
 * How many candidate rows the identity lookup considers before giving up on
 * proving uniqueness. Rows are `{ id, contactId }`, so this is a runaway guard
 * against pathological data, not a page size — a phone tail matching this many
 * records is a data problem, and answering "one person" from a truncated set
 * would be a guess.
 */
const CANDIDATE_LIMIT = 50;

export async function matchByPhone(digits: string): Promise<PhoneMatch> {
  /*
   * DIGITS, NOT CHARACTERS.
   *
   * This compared the last 9 CHARACTERS with `endsWith`, which needs a
   * contiguous run — so a contact stored as "082 123 4567" never matched the
   * same person messaging from +27821234567, and the CRM greeted a customer it
   * already knew as a stranger, then filed a second record for them. The rule
   * now strips non-digits first (phoneMatch.ts), and migration 82 indexes
   * exactly that expression so the lookup stays a single index probe.
   */
  const tail = phoneTail(digits);
  // Too few digits to identify anybody. Matching on a short tail would match
  // EVERY number ending in those digits, which is worse than matching none.
  if (!tail) return { contactId: null, leadId: null, ambiguous: false };

  /*
   * RAW SQL, SO THE TENANT IS NAMED EXPLICITLY.
   *
   * The normalisation cannot be expressed through the ORM, and a raw query does
   * not go through the guard that would otherwise scope it — so the predicate is
   * written here rather than assumed. `activeTenantPredicate` gives the same
   * answer the ORM path would: the scope's tenant when there is one, a hard
   * refusal under enforcement without one, and no predicate at all while
   * dormant, which keeps legacy installs behaving exactly as before.
   *
   * `basePrisma` also means the soft-delete filter is not applied for us, so
   * `deletedAt IS NULL` is stated. Missing it would resurrect deleted customers
   * as match candidates.
   */
  const scope = activeTenantPredicate("inbound phone match");
  // `undefined` means dormant with no scope — the legacy path, where no tenant
  // predicate applied and none should start applying now. Written as a literal
  // in the query below rather than spliced in as a fragment, so the predicate is
  // visible at the call site to a reader and to the tenant-access ratchet.
  const unscoped = scope.tenantId === undefined;
  const scopedTenantId = scope.tenantId ?? null;
  const contactTail = Prisma.raw(PHONE_TAIL_SQL('"phone"'));
  const whatsappTail = Prisma.raw(PHONE_TAIL_SQL('"whatsapp"'));
  const leadTail = Prisma.raw(PHONE_TAIL_SQL('"phone"'));

  // Both tables, always. Stopping at the first matching Contact could not see an
  // unrelated open Lead on the same number, and that is a second person.
  // Oldest first: stable across requests, and the original record rather than a
  // later duplicate. Rows are {id, contactId} only, so the bound is a runaway
  // guard rather than a page size — see CANDIDATE_LIMIT.
  const [contacts, leads] = await Promise.all([
    basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Contact"
      WHERE (${contactTail} = ${tail} OR ${whatsappTail} = ${tail})
        AND "deletedAt" IS NULL
        AND (${unscoped} OR "tenantId" IS NOT DISTINCT FROM ${scopedTenantId})
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT ${CANDIDATE_LIMIT}`,
    basePrisma.$queryRaw<Array<{ id: string; contactId: string | null }>>`
      SELECT "id", "contactId" FROM "Lead"
      WHERE ${leadTail} = ${tail}
        AND "status" = 'open'
        AND (${unscoped} OR "tenantId" IS NOT DISTINCT FROM ${scopedTenantId})
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT ${CANDIDATE_LIMIT}`,
  ]);

  // Hitting the bound means candidates were dropped, so uniqueness cannot be
  // proved — fail closed rather than answer from a truncated set.
  const truncated = contacts.length >= CANDIDATE_LIMIT || leads.length >= CANDIDATE_LIMIT;
  const ambiguous = truncated || distinctIdentities(contacts, leads) > 1;
  if (contacts[0]) return { contactId: contacts[0].id, leadId: null, ambiguous };
  const lead = leads[0];
  return { contactId: lead?.contactId ?? null, leadId: lead?.id ?? null, ambiguous };
}

/**
 * Sends a WhatsApp text message via the Cloud API. Works inside the 24-hour
 * customer-service window (i.e. after the customer messaged you).
 */
export async function sendWhatsAppText(
  toDigits: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const creds = await waCredentials();
  if (!creds) {
    return { ok: false, error: "WhatsApp is not configured (Settings → Integrations)." };
  }
  const res = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "text",
      text: { body: text.slice(0, WA_TEXT_MAX) },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await noteWhatsAppOutcome(creds, res, err);
    const msg: string = err?.error?.message ?? `WhatsApp API error ${res.status}`;
    const friendly = msg.includes("24")
      ? "Outside the 24-hour reply window — the customer must message you first (or use an approved template from WhatsApp Manager)."
      : msg;
    return { ok: false, error: friendly };
  }
  await noteWhatsAppOutcome(creds, res, null);
  return { ok: true };
}

/** Sends an image by URL (e.g. a brochure) on WhatsApp. */
export async function sendWhatsAppImage(toDigits: string, url: string, caption?: string): Promise<{ ok: boolean; error?: string }> {
  const creds = await waCredentials();
  if (!creds) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "image", image: { link: url, ...(caption ? { caption } : {}) } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await noteWhatsAppOutcome(creds, res, err);
    return { ok: false, error: err?.error?.message ?? `WhatsApp API error ${res.status}` };
  }
  await noteWhatsAppOutcome(creds, res, null);
  return { ok: true };
}

/**
 * Uploads a media blob to WhatsApp and returns its media ID. Meta hosts the
 * bytes (valid ~30 days) so we never publish a permanent public URL of our own —
 * the caller sends by id. Returns the id or an error.
 */
export async function uploadWhatsAppMedia(
  buffer: Buffer,
  contentType: string,
  filename: string,
): Promise<{ id: string } | { error: string }> {
  const creds = await waCredentials();
  if (!creds) return { error: "WhatsApp is not configured." };
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", contentType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  const res = await fetch(`${GRAPH}/${creds.phoneNumberId}/media`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { Authorization: `Bearer ${creds.token}` }, // fetch sets the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await noteWhatsAppOutcome(creds, res, err);
    return { error: err?.error?.message ?? `WhatsApp media upload error ${res.status}` };
  }
  await noteWhatsAppOutcome(creds, res, null);
  const json = await res.json().catch(() => null);
  return json?.id ? { id: String(json.id) } : { error: "WhatsApp media upload returned no id" };
}

/** Sends an audio message (e.g. a synthesised voice-note reply) by uploaded media ID. */
export async function sendWhatsAppAudioId(toDigits: string, mediaId: string): Promise<{ ok: boolean; error?: string }> {
  const creds = await waCredentials();
  if (!creds) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "audio", audio: { id: mediaId } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await noteWhatsAppOutcome(creds, res, err);
    return { ok: false, error: err?.error?.message ?? `WhatsApp API error ${res.status}` };
  }
  await noteWhatsAppOutcome(creds, res, null);
  return { ok: true };
}

/** Shared sender behind the button and list messages — both report their outcome. */
async function sendInteractive(toDigits: string, interactive: unknown): Promise<{ ok: boolean; error?: string }> {
  const creds = await waCredentials();
  if (!creds) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "interactive", interactive }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    await noteWhatsAppOutcome(creds, res, err);
    return { ok: false, error: err?.error?.message ?? `WhatsApp API error ${res.status}` };
  }
  await noteWhatsAppOutcome(creds, res, null);
  return { ok: true };
}

/** Sends up to 3 tappable reply buttons. */
export async function sendWhatsAppButtons(
  toDigits: string,
  body: string,
  buttons: { id: string; title: string }[]
) {
  // The limits are imported, not written out here, so the builder's preview
  // cannot disagree with what actually gets sent. Same numbers, same behaviour.
  return sendInteractive(toDigits, {
    type: "button",
    body: { text: body.slice(0, WA_BODY_MAX) },
    action: {
      buttons: buttons.slice(0, WA_BUTTON_MAX).map((b) => ({
        type: "reply",
        reply: { id: b.id.slice(0, 256), title: b.title.slice(0, WA_BUTTON_TITLE_MAX) },
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
    body: { text: body.slice(0, WA_BODY_MAX) },
    action: {
      button: buttonLabel.slice(0, WA_LIST_BUTTON_MAX),
      sections: [
        {
          rows: rows.slice(0, WA_LIST_ROW_MAX).map((r) => ({
            id: r.id.slice(0, 200),
            title: r.title.slice(0, WA_LIST_TITLE_MAX),
            ...(r.description ? { description: r.description.slice(0, WA_LIST_DESCRIPTION_MAX) } : {}),
          })),
        },
      ],
    },
  });
}

/**
 * Downloads a WhatsApp media object (e.g. a voice note) by its media id.
 *
 * Reports its outcome like every other path here, with one deliberate narrowing:
 * this Graph endpoint is addressed by MEDIA id, and Meta expires media after
 * about 30 days. A 404 / error code 100 from it therefore means "that voice note
 * is gone", not "your phone number ID is wrong" — but classifyGraphError, which
 * only ever sees status and body, cannot tell those apart and would classify it
 * as `identity_mismatch`, a reauth-class code. Re-reading an old voice note would
 * then demand a reconnect of a perfectly good integration. So a failure here is
 * reported only for the token-class statuses, which no media id can provoke; a
 * SUCCESS is always reported, and that is the half that heals a stale badge.
 */
export async function fetchWhatsAppMedia(
  mediaId: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const tenantId = ambientTenantId();
  const token = await resolveTenantCredential(tenantId, "WA_ACCESS_TOKEN");
  if (!token) return null;
  // phoneNumberId is empty on purpose: this endpoint is not scoped to it, and the
  // only failures reported below are ones classifyGraphError never quotes it in.
  const creds: WhatsAppCredentials = {
    tenantId: credentialOwnerTenantId(tenantId),
    phoneNumberId: "",
    token,
  };
  try {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!metaRes.ok) {
      if (metaRes.status === 401 || metaRes.status === 403) {
        await noteWhatsAppOutcome(creds, metaRes, await metaRes.json().catch(() => null));
      }
      return null;
    }
    await noteWhatsAppOutcome(creds, metaRes, null);
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
  text: string,
  /** The provider's message id, so a redelivery reuses this row instead of adding one. */
  providerMessageId?: string,
) {
  const match = await matchByPhone(fromDigits);
  let { contactId } = match;
  const { leadId } = match;

  /*
   * AN UNKNOWN NUMBER BECOMES A PERSON, NOT A SALES LEAD.
   *
   * This created a Lead in the first pipeline stage for every unrecognised
   * number — before anyone, human or bot, knew what the message was about. A
   * customer messaging to book a service therefore arrived as a sales lead, and
   * the flow's `booking` node then correctly created the service request beside
   * it, leaving a lead nobody wanted sitting in the pipeline. It had also
   * already fired the "New lead" push and enrolled the person in every
   * `lead_created` journey by then, so the wrong classification had consequences
   * that outlived it.
   *
   * The flow engine already knows the difference — `BookingCreateAction` is
   * "service" | "demo" | "lead" — so intent belongs to the node that establishes
   * it, not to the act of receiving a message.
   *
   * MESSENGER AND INSTAGRAM ALREADY WORK THIS WAY. recordInboundDm creates a
   * Contact for every unknown sender and a Lead only when the DM carries ad
   * attribution, i.e. only when it genuinely IS a sales enquiry. This makes
   * WhatsApp consistent with the channel that had it right.
   *
   * A Contact, not nothing: the message still needs a person to hang off, the
   * inbox still shows who is talking, and a returning customer is recognised
   * rather than filed twice.
   */
  if (!contactId && !leadId) {
    const [firstName, ...rest] = (profileName ?? "WhatsApp contact").trim().split(/\s+/);
    const created = await prisma.contact.create({
      data: {
        firstName: firstName || "WhatsApp contact",
        lastName: rest.join(" ") || null,
        phone: "+" + fromDigits,
        whatsapp: "+" + fromDigits,
        source: "whatsapp",
        notes: profileName ? null : "Created from an inbound WhatsApp message — name not yet available.",
      },
    });
    contactId = created.id;
    await logAudit({
      action: "contact.created",
      summary: "Contact created from an inbound WhatsApp message",
      contactId: created.id,
      userName: "System",
    });
  }

  // Tenant-aware actor: under enforcement, a member of THIS channel's tenant scope
  // (established by the webhook chokepoint); dormant → the oldest active user.
  const firstUser = await resolveTenantActor();
  if (!firstUser) return;
  // create(), NOT createMany(): db.ts extends communication.create to resolve and
  // attach the Conversation and then bump its counters, unread flag and
  // last-inbound timestamp. There is no createMany hook, so batching would file
  // messages with no Conversation at all — and assignment, notes, drafts and
  // bot/human ownership all hang off Conversation rows. The unique dedupeKey is
  // the replay signal instead: the first delivery takes the normal path with every
  // hook, a redelivery is refused by the index.
  const dedupeKey = inboundCommunicationKey({
    ledgerEventId: currentInboundBotEventId(),
    tenantId: writeTenantId() ?? DEFAULT_TENANT_ID,
    channel: "whatsapp",
    providerId: providerMessageId ?? "",
  });
  let inserted = true;
  try {
    await prisma.communication.create({
      data: {
        type: "whatsapp",
        direction: "inbound",
        body: text,
        contactId,
        leadId,
        userId: firstUser.id,
        // The dedupe key above falls back to DEFAULT_TENANT_ID because it only has to
        // be STABLE. Ownership is a different standard and must never be invented:
        // the customer record decides, or nobody does.
        tenantId: await customerRecordTenantId({ contactId, leadId }),
        ...(dedupeKey ? { dedupeKey } : {}),
      },
    });
  } catch (error) {
    if (!dedupeKey || !isDedupeKeyConflict(error)) throw error;
    inserted = false;
  }

  // Notify immediately after the row lands, BEFORE the other fallible work below.
  // "The transcript row already existed" is not the same fact as "the notification
  // already went out", and ordering it here is what keeps them close enough to be
  // honest: the only way to reach this on a replay is a genuine duplicate insert.
  if (inserted) {
    await sendPushToAll({
      title: "New WhatsApp message 💬",
      body: `${profileName ?? "+" + fromDigits}: ${text.slice(0, 80)}`,
      url: "/messages",
    }, "whatsapp").catch(() => {});
  }

  const { reopenThreadOnInbound } = await import("@/lib/reopenThread");
  await reopenThreadOnInbound(contactId, leadId, "whatsapp");

  // Notify on every inbound — WhatsApp is the primary contact channel. Opens the
  // Messages app so replies aren't lost in the CRM.

}
