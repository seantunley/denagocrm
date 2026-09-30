import { redactUrl } from "./redactUrl";

/**
 * EVERY MESSAGE THE CRM SENDS A CUSTOMER LANDS ON THAT CUSTOMER'S TIMELINE.
 *
 * Staff-composed mail (EmailComposer), journeys, service reminders and the bot
 * already wrote a `Communication`. The automated paths did not: a signing
 * invitation for "Quote Q-1026" left the building with nothing behind it but a
 * recipient status and an audit line, so when one went to the wrong customer the
 * owner could not see what that customer had actually received.
 *
 * The record is written by the SHARED send functions (`sendEmail`, `sendSms`,
 * `sendWhatsAppText`) when a caller passes `record`, and only after the provider
 * accepted the message — so it is a record of what went out, never of an attempt.
 * Callers that already write their own Communication simply don't pass `record`.
 *
 * Capabilities are never copied onto the timeline: one-time codes passed as
 * `secrets` are masked wherever they appear, and every signing / approval / survey
 * / tracking link is reduced to its route shape by `redactUrl`. A timeline is read
 * by every rep with access to the customer; a working signing link there is a
 * way to sign as that customer.
 *
 * Pure apart from `recordOutboundMessage` / `recordOutboundFailure`, whose server
 * dependencies are imported lazily so the builders stay unit-testable.
 */

export type OutboundChannel = "email" | "sms" | "whatsapp";

/** Which customer record a send belongs to, and how to show it. */
export type OutboundRecord = {
  contactId?: string | null;
  leadId?: string | null;
  /** Staff user to attribute the row to; falls back to the workspace's system actor. */
  userId?: string | null;
  /** Values that must never be stored — one-time codes, raw tokens. Masked everywhere. */
  secrets?: Array<string | null | undefined>;
  /** Short tag shown at the top of the body, e.g. "Signing invitation". */
  label?: string;
};

export type OutboundMessage = {
  channel: OutboundChannel;
  to: string;
  subject?: string | null;
  text: string;
  /** Attachment file names, listed under the body (the files are not copied). */
  attachments?: string[];
  /** Provider message id (SMTP Message-ID, BulkSMS id, WhatsApp wamid). */
  messageId?: string | null;
  occurredAt?: Date;
};

export const SECRET_MASK = "••••••";

/** Masks every secret, then every capability link. */
export function redactOutbound(text: string, secrets: OutboundRecord["secrets"] = []): string {
  let out = text;
  for (const secret of secrets) {
    // Anything shorter than a 4-digit code would mask ordinary words and numbers.
    if (secret && secret.length >= 4) out = out.split(secret).join(SECRET_MASK);
  }
  return redactUrl(out);
}

/** The Communication fields for a message the provider accepted (minus userId / tenantId). */
export function outboundTimelineEntry(msg: OutboundMessage, record: OutboundRecord) {
  const lines = [
    record.label ? `[${record.label}]` : null,
    `To: ${msg.to}`,
    "",
    msg.text,
    msg.attachments?.length ? `\n[Attachments: ${msg.attachments.join(", ")}]` : null,
  ].filter((line): line is string => line !== null);
  return {
    type: msg.channel,
    direction: "outbound" as const,
    subject: msg.subject ? redactOutbound(msg.subject, record.secrets) : null,
    body: redactOutbound(lines.join("\n"), record.secrets),
    contactId: record.contactId ?? null,
    leadId: record.leadId ?? null,
    messageId: msg.messageId ?? null,
    occurredAt: msg.occurredAt ?? new Date(),
  };
}

/**
 * Write the timeline row. Never throws: the message has already gone, and a
 * failed bookkeeping write must not turn a delivered message into a reported
 * failure (callers retry on failure — the customer would get it twice).
 */
export async function recordOutboundMessage(msg: OutboundMessage, record: OutboundRecord): Promise<void> {
  if (!record.contactId && !record.leadId) return; // nothing to hang it on
  try {
    const [{ prisma }, { customerRecordTenantId }, { withTenant }, actors] = await Promise.all([
      import("./db"),
      import("./customerRecordTenant"),
      import("./tenantScope"),
      import("./tenantActor"),
    ]);
    const tenantId = await customerRecordTenantId({ contactId: record.contactId, leadId: record.leadId });
    const write = async () => {
      const user =
        (record.userId ? await actors.resolveTenantMemberUser(record.userId) : null) ??
        (await actors.resolveTenantActor());
      if (!user) return;
      await prisma.communication.create({
        data: { ...outboundTimelineEntry(msg, record), userId: user.id, tenantId },
      });
    };
    // Pin the row's own tenant so the RLS context matches it whatever scope the
    // send ran in (a system-scoped cron drain, a token-scoped public route).
    await (tenantId ? withTenant(tenantId, write) : write());
  } catch (err) {
    const { logError } = await import("./errorLog");
    // Record ids only — the recipient and content are client information.
    await logError("outbound-record", err, `${msg.channel} accepted but not recorded (contact ${record.contactId ?? "-"}, lead ${record.leadId ?? "-"})`);
  }
}

/** The audit line for a send the provider did NOT accept. */
export function outboundFailureSummary(msg: Omit<OutboundMessage, "messageId">, record: OutboundRecord, error?: string): string {
  const what = record.label ?? `${msg.channel === "email" ? "Email" : msg.channel === "sms" ? "SMS" : "WhatsApp"}`;
  const subject = msg.subject ? ` “${redactOutbound(msg.subject, record.secrets)}”` : "";
  const why = error ? ` — ${redactOutbound(error, record.secrets).slice(0, 200)}` : "";
  return `NOT DELIVERED: ${what}${subject} to ${msg.to}${why}`;
}

/**
 * A failed send, on the customer's audit trail (which keeps client details by
 * decision). ErrorLog gets nothing new here — the send functions already log the
 * error class there without recipient or content. Never throws.
 */
export async function recordOutboundFailure(
  msg: Omit<OutboundMessage, "messageId">,
  record: OutboundRecord,
  error?: string,
): Promise<void> {
  if (!record.contactId && !record.leadId) return;
  try {
    const { logAudit } = await import("./audit");
    await logAudit({
      action: `${msg.channel}.failed`,
      summary: outboundFailureSummary(msg, record, error),
      contactId: record.contactId ?? null,
      leadId: record.leadId ?? null,
      userName: "System",
    });
  } catch {
    /* bookkeeping must never break a send */
  }
}

/**
 * The customer a signing request is about: its own contact, else the quote's or
 * job card's. Falls back to the one contact in the request's workspace holding
 * the recipient's email, when exactly one does — a hub document sent to a
 * customer's address still belongs on that customer's timeline.
 *
 * `basePrisma` for the same pre-scope reason as `customerRecordTenantId`: these
 * are by-id reads that decide where the row goes, and they run from public
 * signing routes and queue workers as well as staff actions.
 */
export async function signingRecord(
  requestId: string,
  opts: { email?: string | null; label: string; secrets?: OutboundRecord["secrets"] },
): Promise<OutboundRecord> {
  const base: OutboundRecord = { label: opts.label, secrets: opts.secrets };
  try {
    const { basePrisma } = await import("./db");
    const req = await basePrisma.signatureRequest.findUnique({
      where: { id: requestId },
      select: { tenantId: true, contactId: true, quoteId: true, jobCardId: true, createdById: true },
    });
    if (!req) return base;
    let contactId = req.contactId;
    let leadId: string | null = null;
    if (req.quoteId) {
      const quote = await basePrisma.quote.findFirst({
        where: { id: req.quoteId, tenantId: req.tenantId },
        select: { contactId: true, leadId: true },
      });
      contactId ??= quote?.contactId ?? null;
      leadId = quote?.leadId ?? null;
    }
    if (!contactId && req.jobCardId) {
      const card = await basePrisma.jobCard.findFirst({
        where: { id: req.jobCardId, tenantId: req.tenantId },
        select: { contactId: true },
      });
      contactId = card?.contactId ?? null;
    }
    if (!contactId && !leadId && opts.email && req.tenantId) {
      const { ciExactIds } = await import("./ciExact");
      const matches = await basePrisma.contact.findMany({
        where: { id: { in: await ciExactIds("contactEmail", opts.email) }, tenantId: req.tenantId, deletedAt: null },
        select: { id: true },
        take: 2,
      });
      if (matches.length === 1) contactId = matches[0].id;
    }
    return { ...base, contactId, leadId, userId: req.createdById };
  } catch {
    return base; // an unresolvable record never blocks the send
  }
}
