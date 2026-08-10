import { prisma } from "./db";
import { credentialOwnerTenantId, resolveIntegrationBundleForTenant, resolveTenantCredential } from "./settings";
import { sendPushToAll } from "./push";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { resolveTenantActor } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";

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
 * `endsWith` is what was meant. The ordering makes the pick deterministic. And
 * `ambiguous` reports what a single row cannot: that the number did not identify
 * ONE person. Ordinary conversation still uses the deterministic pick — an inbound
 * message must be filed somewhere — but an action that touches an existing booking
 * refuses it, because "probably this customer" is not identity.
 */
export type PhoneMatch = { contactId: string | null; leadId: string | null; ambiguous: boolean };

export async function matchByPhone(digits: string): Promise<PhoneMatch> {
  const variants = [digits, "0" + digits.slice(2), "+" + digits];
  const tails = [...new Set(variants.map((v) => v.slice(-9)))];
  const contacts = await prisma.contact.findMany({
    where: {
      OR: tails.flatMap((tail) => [
        { phone: { endsWith: tail } },
        { whatsapp: { endsWith: tail } },
      ]),
    },
    // Oldest first: stable across requests, and the original record rather than a
    // later duplicate. `take: 2` only to detect that there IS a second one.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: { id: true },
  });
  if (contacts[0]) return { contactId: contacts[0].id, leadId: null, ambiguous: contacts.length > 1 };

  const leads = await prisma.lead.findMany({
    where: { phone: { endsWith: digits.slice(-9) }, status: "open" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: { id: true, contactId: true },
  });
  const lead = leads[0];
  return { contactId: lead?.contactId ?? null, leadId: lead?.id ?? null, ambiguous: leads.length > 1 };
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
      text: { body: text },
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
  text: string
) {
  const match = await matchByPhone(fromDigits);
  const { contactId } = match;
  let { leadId } = match;

  // unknown number → create a lead so nothing is lost
  if (!contactId && !leadId) {
    // Through the one lead creator. This used to be a bare prisma.lead.create
    // plus an audit line, so an inbound WhatsApp lead fired NO `lead_created`
    // automations and raised no "New lead" push — the rule a user configures as
    // "when a new lead is created, notify me" did nothing for the channel most
    // of them arrive on. (The "New WhatsApp message" push below is about the
    // MESSAGE and sits on its own toggle; `lead_new` is the one whose settings
    // description already promised "…website or WhatsApp lead arrives".)
    //
    // …IfPipelineReady keeps the old `if (firstStage)` guard: with no pipeline
    // configured we still record the message below rather than losing it.
    const title = `WhatsApp enquiry — ${profileName ?? fromDigits}`;
    const lead = await createLeadRecordIfPipelineReady({
      title,
      name: profileName ?? `WhatsApp ${fromDigits}`,
      phone: "+" + fromDigits,
      source: "whatsapp",
      audit: {
        action: "lead.received",
        summary: `Lead “${title}” created from inbound WhatsApp`,
        userName: "System",
      },
    });
    if (lead) leadId = lead.id;
  }

  // Tenant-aware actor: under enforcement, a member of THIS channel's tenant scope
  // (established by the webhook chokepoint); dormant → the oldest active user.
  const firstUser = await resolveTenantActor();
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
  const { reopenThreadOnInbound } = await import("@/lib/reopenThread");
  await reopenThreadOnInbound(contactId, leadId, "whatsapp");

  // Notify on every inbound — WhatsApp is the primary contact channel. Opens the
  // Messages app so replies aren't lost in the CRM.
  await sendPushToAll({
    title: "New WhatsApp message 💬",
    body: `${profileName ?? "+" + fromDigits}: ${text.slice(0, 80)}`,
    url: "/messages",
  }, "whatsapp").catch(() => {});
}
