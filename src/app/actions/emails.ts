"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sendEmail } from "@/lib/email";

export type SendEmailState = { ok?: string; error?: string };

/** Sends an email and logs it as an outbound communication on the lead/contact. */
export async function sendEmailAction(
  _prev: SendEmailState | undefined,
  formData: FormData
): Promise<SendEmailState> {
  const user = await requireUser();
  const to = String(formData.get("to") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "").trim() || null;
  const contactId = String(formData.get("contactId") ?? "").trim() || null;

  if (!to || !subject || !body) {
    return { error: "To, subject and message are required." };
  }

  const result = await sendEmail({ to, subject, text: body });
  if (!result.ok) return { error: result.error };

  await prisma.communication.create({
    data: {
      type: "email",
      direction: "outbound",
      subject,
      body,
      leadId,
      contactId,
      userId: user.id,
    },
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
  return { ok: `Email sent to ${to}.` };
}

export async function sendTestEmail(
  _prev: SendEmailState | undefined
): Promise<SendEmailState> {
  const user = await requireUser();
  const result = await sendEmail({
    to: user.email,
    subject: "Denago CRM test email",
    text: "Your SMTP settings are working. — Denago CRM",
  });
  return result.ok
    ? { ok: `Test email sent to ${user.email}.` }
    : { error: result.error };
}

// ---- SMTP settings ----

export async function saveSmtpSettings(formData: FormData) {
  await requireUser();
  const entries: Record<string, string> = {
    SMTP_HOST: String(formData.get("host") ?? "").trim(),
    SMTP_PORT: String(formData.get("port") ?? "587").trim(),
    SMTP_SECURE: formData.get("secure") === "on" ? "true" : "false",
    SMTP_USER: String(formData.get("user") ?? "").trim(),
    SMTP_PASS: String(formData.get("pass") ?? "").trim(),
    SMTP_FROM: String(formData.get("from") ?? "").trim(),
  };
  for (const [key, value] of Object.entries(entries)) {
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
  revalidatePath("/settings");
}

// ---- Email templates ----

export async function createTemplate(formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!name || !subject || !body) return;
  await prisma.emailTemplate.create({ data: { name, subject, body } });
  revalidatePath("/settings");
}

export async function updateTemplate(id: string, formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!name || !subject || !body) return;
  await prisma.emailTemplate.update({ where: { id }, data: { name, subject, body } });
  revalidatePath("/settings");
}

export async function deleteTemplate(id: string) {
  await requireUser();
  await prisma.emailTemplate.delete({ where: { id } });
  revalidatePath("/settings");
}
