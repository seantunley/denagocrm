import nodemailer from "nodemailer";
import { getSetting } from "./settings";
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
  return (await getSmtpConfig()) != null;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
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
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      attachments: input.attachments,
    });
    return { ok: true };
  } catch (err) {
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
