import { prisma } from "./db";
import { resolveIntegrationBundle, resolveTenantCredential } from "./settings";
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

/** Resolves the phone-number id + access token, honouring a tenant override. */
async function waCredentials(): Promise<[string | null, string | null]> {
  const tenantId = ambientTenantId();
  const bundle = await resolveIntegrationBundle(tenantId, "whatsapp");
  if (!bundle) return [null, null];
  return [bundle.WA_PHONE_NUMBER_ID, bundle.WA_ACCESS_TOKEN];
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
 * Fire-and-forget and fully swallowed: this is bookkeeping hanging off a
 * customer-facing send, and it must never add latency to it or change its
 * result. Only auth-class failures flip the status — see REAUTH_FAILURE_CODES.
 */
function noteWhatsAppOutcome(
  phoneNumberId: string,
  token: string,
  res: { ok: boolean; status: number },
  body: unknown,
): void {
  void (async () => {
    try {
      const [{ noteIntegrationSendOutcome }, { classifyGraphError }] = await Promise.all([
        import("./integrationConnection"),
        import("./integrationProbe"),
      ]);
      const tenantId = ambientTenantId();
      if (res.ok) {
        await noteIntegrationSendOutcome(tenantId, "whatsapp", { ok: true });
        return;
      }
      const failure = classifyGraphError(res.status, body, { phoneNumberId, accessToken: token });
      await noteIntegrationSendOutcome(tenantId, "whatsapp", { ok: false, failure }, [token]);
    } catch {
      /* bookkeeping must never break a send */
    }
  })();
}

/** Normalises a phone number to WhatsApp digits (27…). */
export function waDigits(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0")) d = "27" + d.slice(1);
  return d;
}

export async function isWhatsAppConfigured(): Promise<boolean> {
  const [id, token] = await waCredentials();
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
  const [phoneNumberId, token] = await waCredentials();
  if (!phoneNumberId || !token) {
    return { ok: false, error: "WhatsApp is not configured (Settings → Integrations)." };
  }
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
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
    noteWhatsAppOutcome(phoneNumberId, token, res, err);
    const msg: string = err?.error?.message ?? `WhatsApp API error ${res.status}`;
    const friendly = msg.includes("24")
      ? "Outside the 24-hour reply window — the customer must message you first (or use an approved template from WhatsApp Manager)."
      : msg;
    return { ok: false, error: friendly };
  }
  noteWhatsAppOutcome(phoneNumberId, token, res, null);
  return { ok: true };
}

/** Sends an image by URL (e.g. a brochure) on WhatsApp. */
export async function sendWhatsAppImage(toDigits: string, url: string, caption?: string): Promise<{ ok: boolean; error?: string }> {
  const [phoneNumberId, token] = await waCredentials();
  if (!phoneNumberId || !token) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
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
  const [phoneNumberId, token] = await waCredentials();
  if (!phoneNumberId || !token) return { error: "WhatsApp is not configured." };
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", contentType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  const res = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }, // fetch sets the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { error: err?.error?.message ?? `WhatsApp media upload error ${res.status}` };
  }
  const json = await res.json().catch(() => null);
  return json?.id ? { id: String(json.id) } : { error: "WhatsApp media upload returned no id" };
}

/** Sends an audio message (e.g. a synthesised voice-note reply) by uploaded media ID. */
export async function sendWhatsAppAudioId(toDigits: string, mediaId: string): Promise<{ ok: boolean; error?: string }> {
  const [phoneNumberId, token] = await waCredentials();
  if (!phoneNumberId || !token) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "audio", audio: { id: mediaId } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { ok: false, error: err?.error?.message ?? `WhatsApp API error ${res.status}` };
  }
  return { ok: true };
}

async function sendInteractive(toDigits: string, interactive: unknown): Promise<{ ok: boolean; error?: string }> {
  const [phoneNumberId, token] = await waCredentials();
  if (!phoneNumberId || !token) return { ok: false, error: "WhatsApp is not configured." };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
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
  const token = await resolveTenantCredential(ambientTenantId(), "WA_ACCESS_TOKEN");
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
