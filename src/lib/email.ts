import nodemailer from "nodemailer";
import { PLATFORM_TEAM_SIGNOFF } from "./platformIdentity";
import { resolveIntegrationBundleForTenant } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { formatZAR } from "./format";

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
}): Promise<{ ok: boolean; error?: string }> {
  const config = await getSmtpConfig();
  if (!config) return { ok: false, error: "SMTP is not configured (see Settings → Email)." };
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
    });
    await transporter.sendMail({
      from: fromHeader(config),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    });
    await noteSmtpOutcome(config, null);
    return { ok: true };
  } catch (err) {
    await noteSmtpOutcome(config, err);
    const { logError } = await import("./errorLog");
    await logError("smtp", err, `to: ${input.to} — ${input.subject}`);
    return { ok: false, error: err instanceof Error ? err.message : "Failed to send email" };
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
}, teamName: string = DEFAULT_TEAM_SIGNOFF): Record<string, string> {
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name;
  return {
    name: lead.name,
    first_name: firstName,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    model: lead.product?.name ?? "",
    color: lead.color ?? "",
    value: lead.valueCents ? formatZAR(lead.valueCents) : "",
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
