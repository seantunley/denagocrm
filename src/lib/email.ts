import nodemailer from "nodemailer";
import { PLATFORM_TEAM_SIGNOFF } from "./platformIdentity";
import { resolveIntegrationBundle } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { formatZAR } from "./format";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
};

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const tenantId = currentTenantScope()?.tenantId ?? null;
  const bundle = await resolveIntegrationBundle(tenantId, "smtp");
  if (!bundle) return null;
  const host = bundle.SMTP_HOST;
  const from = bundle.SMTP_FROM;
  if (!host || !from) return null;
  return {
    host,
    port: bundle.SMTP_PORT ? parseInt(bundle.SMTP_PORT, 10) : 587,
    secure: bundle.SMTP_SECURE === "true",
    user: bundle.SMTP_USER,
    pass: bundle.SMTP_PASS,
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
    return { ok: true };
  } catch (err) {
    const { logError } = await import("./errorLog");
    await logError("smtp", err, `to: ${input.to} — ${input.subject}`);
    return { ok: false, error: err instanceof Error ? err.message : "Failed to send email" };
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
