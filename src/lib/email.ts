import nodemailer from "nodemailer";
import { getSetting } from "./settings";
import { formatZAR } from "./format";
import { getTenantEmailProviderConfig } from "./emailProviderConfig";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
};

export type SendGridConfig = {
  apiKey: string;
  from: string;
};

export type EmailSendResult = {
  ok: boolean;
  error?: string;
  provider?: "sendgrid" | "smtp";
  messageId?: string;
};

type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  headers?: Record<string, string>;
  campaign?: { campaignId: string; recipientId: string };
};

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const [host, port, secure, user, pass, from] = await Promise.all([
    getSetting("SMTP_HOST"),
    getSetting("SMTP_PORT"),
    getSetting("SMTP_SECURE"),
    getSetting("SMTP_USER"),
    getSetting("SMTP_PASS"),
    getSetting("SMTP_FROM"),
  ]);
  if (!host || !from) return null;
  return {
    host,
    port: port ? parseInt(port, 10) : 587,
    secure: secure === "true",
    user,
    pass,
    from,
  };
}

export async function isSmtpConfigured(): Promise<boolean> {
  return (await getSendGridConfig()) != null || (await getSmtpConfig()) != null;
}

export async function getSendGridConfig(): Promise<SendGridConfig | null> {
  const [configured, smtpFrom] = await Promise.all([
    getTenantEmailProviderConfig(),
    getSetting("SMTP_FROM"),
  ]);
  const from = configured.from || smtpFrom;
  if (!configured.apiKey || !from) return null;
  return { apiKey: configured.apiKey, from };
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

function sendGridAddress(value: string): { email: string; name?: string } {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:"?([^"<]+?)"?\s*)?<([^>]+)>$/);
  if (!match) return { email: trimmed };
  const name = match[1]?.trim();
  return { email: match[2].trim(), ...(name ? { name } : {}) };
}

export function buildSendGridPayload(input: EmailInput, from: string) {
  const content = [{ type: "text/plain", value: input.text }];
  if (input.html) content.push({ type: "text/html", value: input.html });
  return {
    personalizations: [{
      to: [sendGridAddress(input.to)],
      subject: input.subject,
      ...(input.campaign
        ? {
            custom_args: {
              crm_campaign_id: input.campaign.campaignId,
              crm_recipient_id: input.campaign.recipientId,
            },
          }
        : {}),
    }],
    from: sendGridAddress(from),
    content,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((attachment) => ({
            content: attachment.content.toString("base64"),
            filename: attachment.filename,
            type: attachment.contentType,
            disposition: "attachment",
          })),
        }
      : {}),
    categories: input.campaign ? ["crm_campaign"] : ["crm_transactional"],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    },
  };
}

async function sendWithSendGrid(
  input: EmailInput,
  config: SendGridConfig,
): Promise<EmailSendResult> {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSendGridPayload(input, config.from)),
  });
  const messageId = response.headers.get("x-message-id") ?? undefined;
  if (response.ok) return { ok: true, provider: "sendgrid", messageId };
  const detail = (await response.text()).slice(0, 500);
  return {
    ok: false,
    provider: "sendgrid",
    messageId,
    error: detail || `SendGrid rejected the message (${response.status}).`,
  };
}

export async function sendEmail(input: EmailInput): Promise<EmailSendResult> {
  const sendGrid = await getSendGridConfig();
  if (sendGrid) {
    try {
      return await sendWithSendGrid(input, sendGrid);
    } catch (err) {
      const { logError } = await import("./errorLog");
      await logError("sendgrid", err, `to: ${input.to} — ${input.subject}`);
      return {
        ok: false,
        provider: "sendgrid",
        error: err instanceof Error ? err.message : "Failed to send email",
      };
    }
  }

  const config = await getSmtpConfig();
  if (!config) return { ok: false, error: "SMTP is not configured (see Settings → Email)." };
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
    });
    const info = await transporter.sendMail({
      from: fromHeader(config),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      headers: input.headers,
    });
    return { ok: true, provider: "smtp", messageId: info.messageId };
  } catch (err) {
    const { logError } = await import("./errorLog");
    await logError("smtp", err, `to: ${input.to} — ${input.subject}`);
    return { ok: false, error: err instanceof Error ? err.message : "Failed to send email" };
  }
}

/** Replaces {{placeholder}} tokens; unknown tokens are left blank. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function leadVars(lead: {
  name: string;
  email?: string | null;
  phone?: string | null;
  color?: string | null;
  valueCents?: number;
  product?: { name: string } | null;
  assignedTo?: { name: string } | null;
}): Record<string, string> {
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name;
  return {
    name: lead.name,
    first_name: firstName,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    model: lead.product?.name ?? "",
    color: lead.color ?? "",
    value: lead.valueCents ? formatZAR(lead.valueCents) : "",
    user_name: lead.assignedTo?.name ?? "The Denago Cape Town team",
  };
}

export function contactVars(contact: {
  firstName: string;
  lastName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
}): Record<string, string> {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  return {
    name,
    first_name: contact.firstName,
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    model: "",
    color: "",
    value: "",
    user_name: "The Denago Cape Town team",
  };
}
