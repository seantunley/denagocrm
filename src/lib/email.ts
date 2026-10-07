import nodemailer from "nodemailer";
import { PLATFORM_TEAM_SIGNOFF } from "./platformIdentity";
import { getSetting, resolveIntegrationBundleForTenant } from "./settings";
import { EMAIL_OPEN_TRACKING_KEY, newOpenToken, openTrackingOn, withOpenPixel } from "./emailOpenTracking";
import { currentTenantScope } from "./tenantScope";
import { inlineImages, workspaceLogoLoader } from "./emailInlineLogo";
import { DEFAULT_REGIONAL, formatZAR, type Regional } from "./format";
import { recordOutboundFailure, recordOutboundMessage, type OutboundRecord } from "./outboundMessageLog";

export type SmtpConfig = {
  /**
   * The tenant these credentials were resolved FOR — carried on the config so
   * the send-health hook is handed a tenant rather than asking ambient scope a
   * second time. Scope is a no-op while enforcement is off, so the second answer
   * would be null and the report would be dropped. Same reasoning, and the same
   * helper, as WhatsAppCredentials in src/lib/whatsapp.ts.
   */
  tenantId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
};

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const bundle = await resolveIntegrationBundleForTenant(currentTenantScope()?.tenantId ?? null, "smtp");
  if (!bundle) return null;
  const host = bundle.values.SMTP_HOST;
  const from = bundle.values.SMTP_FROM;
  if (!host || !from) return null;
  return {
    tenantId: bundle.tenantId,
    host,
    port: bundle.values.SMTP_PORT ? parseInt(bundle.values.SMTP_PORT, 10) : 587,
    secure: bundle.values.SMTP_SECURE === "true",
    user: bundle.values.SMTP_USER,
    pass: bundle.values.SMTP_PASS,
    from,
  };
}

export async function isSmtpConfigured(): Promise<boolean> {
  return (await getSmtpConfig()) != null;
}

/**
 * A deliverable From header. If SMTP_FROM has no email address (e.g. it's just a
 * display name like "Denago Cape Town"), pair it with the authenticated SMTP
 * user so the message has a valid sender and isn't rejected/dropped.
 */
function fromHeader(config: SmtpConfig): string {
  const from = config.from.trim();
  if (from.includes("@")) return from;
  if (config.user && config.user.includes("@")) return `${from} <${config.user}>`;
  return from;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  /**
   * Extra RFC 5322 headers. Added for `List-Unsubscribe` /
   * `List-Unsubscribe-Post`, which are headers rather than body content by
   * definition: the whole point is that the recipient's mail client can offer an
   * unsubscribe control WITHOUT the recipient having to find a link in the
   * message. There was previously nowhere to put one.
   *
   * Deliberately a plain map passed straight to nodemailer rather than a typed
   * union — a caller that needs a header this signature has not heard of should
   * not have to widen a type to send a standards-defined one.
   */
  headers?: Record<string, string>;
  /**
   * `Reply-To`, as a comma-separated address list.
   *
   * Mail goes out as the WORKSPACE (`SMTP_FROM`), so without this a customer's
   * reply lands wherever that address delivers and nowhere else — either the
   * shared mailbox the IMAP sync files against the record, or the person who
   * actually wrote the mail, but not both. The header takes a LIST, which is what
   * lets it be both.
   *
   * A first-class nodemailer field rather than an entry in some `headers` map:
   * nodemailer parses and encodes addresses here, where an arbitrary header would
   * be passed through verbatim. Callers must still validate — see `parseReplyTo`
   * in `replyToAddresses.ts` — because a CR or LF in a header value is header
   * injection, and "the library probably handles it" is not a control.
   */
  replyTo?: string;
  /**
   * Track whether the customer opens it (lib/emailOpenTracking.ts): an HTML
   * mail gets the pixel and the timeline entry its token — unless the owner
   * switched tracking off in Settings → Email. The token comes back on the
   * result for a caller that writes its own timeline entry.
   */
  trackOpens?: boolean;
  /**
   * Our own `Message-ID` (`<id@domain>`), for mail that must be threaded back:
   * a customer's answer names it in In-Reply-To, and the IMAP sync matches that
   * to the ticket. Omitted → nodemailer generates one, as before.
   */
  messageId?: string;
  /**
   * The customer this mail is to. When given, the sent message is written to
   * their timeline once SMTP accepts it (and a failure to their audit trail) —
   * see lib/outboundMessageLog.ts. Omit it where the caller already logs its own
   * Communication, or the mail is not to a customer.
   */
  record?: OutboundRecord;
}): Promise<{ ok: boolean; error?: string; openToken?: string }> {
  const logged: Parameters<typeof recordOutboundMessage>[0] = { channel: "email" as const, to: input.to, subject: input.subject, text: input.text, attachments: input.attachments?.map((a) => a.filename) };
  const config = await getSmtpConfig();
  if (!config) {
    const error = "SMTP is not configured (see Settings → Email).";
    if (input.record) await recordOutboundFailure(logged, input.record, error);
    return { ok: false, error };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // ENCRYPTED OR NOT AT ALL. Without implicit TLS (465), nodemailer upgraded
      // with STARTTLS only if the server offered it, and otherwise sent the
      // password and the customer's mail in clear text. requireTLS makes a server
      // that can't upgrade a failed send instead.
      requireTLS: !config.secure,
      auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
    });
    // Open tracking: the pixel on the workspace's own address, its token on the
    // timeline entry. Never a reason to fail the send.
    let openToken: string | undefined;
    let html = input.html;
    if (html && input.trackOpens) {
      try {
        if (openTrackingOn(await getSetting(EMAIL_OPEN_TRACKING_KEY))) {
          const { tenantOrigin } = await import("./tenantOrigin");
          openToken = newOpenToken();
          html = withOpenPixel(html, await tenantOrigin(config.tenantId), openToken);
          logged.openToken = openToken;
        }
      } catch {
        openToken = undefined;
        html = input.html;
      }
    }
    // The workspace's logo travels INSIDE the message (see emailInlineLogo.ts), so
    // it shows without the reader allowing remote images. Never a reason to fail:
    // anything that goes wrong leaves the original linked logo.
    // The workspace this mail is being SENT AS — config.tenantId, never a second
    // read of ambient scope, which is absent on the system and enforcement-off
    // paths SmtpConfig.tenantId exists to cover (review of #744).
    const inline = html ?await inlineImages(html, workspaceLogoLoader(config.tenantId)).catch(() => null) : null;
    const info = await transporter.sendMail({
      from: fromHeader(config),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: inline?.html ?? html,
      // Inline logos ride along as cid attachments; the timeline's attachment
      // list (`logged`) stays what the sender attached.
      attachments: inline?.attachments.length ? [...(input.attachments ?? []), ...inline.attachments] : input.attachments,
      headers: input.headers,
      // Omitted entirely when absent, so mail that sets no Reply-To is
      // byte-for-byte what it was before this field existed.
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
    });
    await noteSmtpOutcome(config, null);
    if (input.record) await recordOutboundMessage({ ...logged, messageId: info?.messageId ?? null }, input.record);
    return { ok: true, ...(openToken ? { openToken } : {}) };
  } catch (err) {
    await noteSmtpOutcome(config, err);
    const { logError } = await import("./errorLog");
    // No recipient and no subject: both are client information (a subject
    // often names the customer), and the error class is what diagnoses a send.
    await logError("smtp", err, `send failed, ${input.to.split(",").length} recipient(s)`);
    const error = err instanceof Error ? err.message : "Failed to send email";
    if (input.record) await recordOutboundFailure(logged, input.record, error);
    return { ok: false, error };
  }
}

/**
 * Reports how a real send went to this tenant's integration connection state, so
 * a mailbox password that has been changed or expired surfaces as "Reconnect
 * needed" in Settings → Integration overrides rather than silently bouncing
 * every notification.
 *
 * Reuses the SAME classifier the guided setup's connection test uses
 * (classifySmtpError), so the owner reads the same sentence, blamed on the same
 * step, whether the failure was found by the wizard or by a real send. Only
 * auth-class failures flip the status: a mail server that was briefly
 * unreachable must not demand a password nobody got wrong.
 *
 * AWAITED, not fired and forgotten, and reported against `config.tenantId` — the
 * tenant the credentials themselves were resolved for. Both properties match
 * src/lib/whatsapp.ts: an unawaited write dies with the serverless invocation,
 * and a tenant re-read from ambient scope is null on a normal request.
 * `noteIntegrationSendOutcome` registers the write with the platform's
 * post-response mechanism, so the await costs a registration rather than a
 * database round trip. Fully swallowed — bookkeeping must never alter a send.
 *
 * Note this deliberately does NOT pass the raw error to the connection store:
 * classifySmtpError turns it into a curated sentence with the password redacted,
 * whereas a nodemailer error message can quote the AUTH exchange.
 */
async function noteSmtpOutcome(config: SmtpConfig, err: unknown): Promise<void> {
  try {
    const [{ noteIntegrationSendOutcome }, { classifySmtpError }] = await Promise.all([
      import("./integrationConnection"),
      import("./integrationProbe"),
    ]);
    if (!err) {
      await noteIntegrationSendOutcome(config.tenantId, "smtp", { ok: true });
      return;
    }
    const failure = classifySmtpError(err, config);
    await noteIntegrationSendOutcome(config.tenantId, "smtp", { ok: false, failure }, [config.pass]);
  } catch {
    /* bookkeeping must never break a send */
  }
}

/**
 * Replaces {{placeholder}} tokens; unknown tokens are left blank.
 *
 * The implementation moved to `./template` so it can be imported without this
 * module's nodemailer / settings / tenant-scope dependencies — the journey
 * `variables` step needs it and must stay pure. Re-exported here so that every
 * existing `from "@/lib/email"` import keeps working; there is still exactly
 * one copy of the substitution rule.
 */
export { renderTemplate } from "./template";

/**
 *  signs off a templated email when no owner is assigned. Passed in,
 * with the original literal as the default, because these helpers are
 * SYNCHRONOUS and a brand lookup is not — making them async would ripple through
 * both call sites and every future one for a sign-off line. An omitted argument
 * is byte-for-byte the old behaviour.
 */
/**
 * DEFAULT_TEAM_SIGNOFF signs a templated email when no owner is assigned.
 *
 * Passed in as a parameter with the original literal as its default, rather than
 * resolved here, because these helpers are SYNCHRONOUS and a brand lookup is
 * not. Making them async would ripple through both call sites and every future
 * one, for a sign-off line. An omitted argument is byte-for-byte the old
 * behaviour.
 */
export const DEFAULT_TEAM_SIGNOFF = PLATFORM_TEAM_SIGNOFF;

export function leadVars(lead: {
  name: string;
  email?: string | null;
  phone?: string | null;
  color?: string | null;
  valueCents?: number;
  product?: { name: string } | null;
  assignedTo?: { name: string } | null;
}, teamName: string = DEFAULT_TEAM_SIGNOFF, money: Pick<Regional, "currency" | "locale"> = DEFAULT_REGIONAL): Record<string, string> {
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name;
  return {
    name: lead.name,
    first_name: firstName,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    model: lead.product?.name ?? "",
    color: lead.color ?? "",
    value: lead.valueCents ? formatZAR(lead.valueCents, money) : "",
    user_name: lead.assignedTo?.name ?? teamName,
  };
}

export function contactVars(contact: {
  firstName: string;
  lastName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
}, teamName: string = DEFAULT_TEAM_SIGNOFF): Record<string, string> {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  return {
    name,
    first_name: contact.firstName,
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    model: "",
    color: "",
    value: "",
    user_name: teamName,
  };
}
