"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { putSetting } from "@/lib/settings";
import { requireCrmOrWorkshop, requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { buildSignature, buildEmailHtml, htmlToText } from "@/lib/signature";
import { readFile } from "@/lib/storage";

export type SendEmailState = { ok?: string; error?: string };

/** Sends an email and logs it as an outbound communication on the lead/contact. */
export async function sendEmailAction(
  _prev: SendEmailState | undefined,
  formData: FormData
): Promise<SendEmailState> {
  const user = await requireCrmOrWorkshop();
  const to = String(formData.get("to") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const bodyHtml = String(formData.get("bodyHtml") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "").trim() || null;
  const contactId = String(formData.get("contactId") ?? "").trim() || null;

  const bodyText = htmlToText(bodyHtml);
  if (!to || !subject || !bodyText) {
    return { error: "To, subject and message are required." };
  }
  const signature = buildSignature(user);
  const html = buildEmailHtml(bodyHtml, signature);

  // Library attachments (selected version ids)
  const attachIds = formData.getAll("attach").map(String).filter(Boolean);
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  const attachedNames: string[] = [];
  if (attachIds.length > 0) {
    const versions = await prisma.libraryVersion.findMany({
      where: { id: { in: attachIds } },
      include: { document: true },
    });
    for (const v of versions) {
      try {
        attachments.push({
          filename: v.fileName,
          content: await readFile(v.storedName),
          contentType: v.mimeType,
        });
        attachedNames.push(`${v.document.name} (v${v.version})`);
      } catch {
        return { error: `Attachment “${v.fileName}” could not be read from storage.` };
      }
    }
  }

  const result = await sendEmail({
    to,
    subject,
    text: `${bodyText}\n\n--\n${user.name} · Denago Cape Town · 073 789 3438`,
    html,
    attachments,
  });
  if (!result.ok) return { error: result.error };

  await prisma.communication.create({
    data: {
      type: "email",
      direction: "outbound",
      subject,
      body:
        attachedNames.length > 0
          ? `${bodyText}\n\n[Attachments: ${attachedNames.join(", ")}]`
          : bodyText,
      leadId,
      contactId,
      userId: user.id,
    },
  });
  await logAudit({
    action: "email.sent",
    summary: `Sent email to ${to}: “${subject}”${
      attachedNames.length > 0 ? ` (attached: ${attachedNames.join(", ")})` : ""
    }`,
    contactId,
    leadId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
  return { ok: `Email sent to ${to}.` };
}

export async function sendTestEmail(
  _prev: SendEmailState | undefined
): Promise<SendEmailState> {
  const user = await requireOwner();
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
  await requireOwner();
  const entries: Record<string, string> = {
    SMTP_HOST: String(formData.get("host") ?? "").trim(),
    SMTP_PORT: String(formData.get("port") ?? "587").trim(),
    SMTP_SECURE: formData.get("secure") === "on" ? "true" : "false",
    SMTP_USER: String(formData.get("user") ?? "").trim(),
    SMTP_PASS: String(formData.get("pass") ?? "").trim(),
    SMTP_FROM: String(formData.get("from") ?? "").trim(),
  };
  for (const [key, value] of Object.entries(entries)) {
    await putSetting(key, value);
  }
  revalidatePath("/settings");
}

export async function saveServiceReminderSettings(formData: FormData) {
  await requireOwner();
  const entries: Record<string, string> = {
    SERVICE_REMINDER_ENABLED: formData.get("enabled") === "on" ? "true" : "false",
    SERVICE_REMINDER_TEMPLATE_ID: String(formData.get("templateId") ?? "").trim(),
  };
  for (const [key, value] of Object.entries(entries)) {
    await putSetting(key, value);
  }
  revalidatePath("/settings");
}

export async function saveLifecycleSettings(formData: FormData) {
  await requireOwner();
  const entries: Record<string, string> = {
    LIFECYCLE_ANNIVERSARY_ENABLED: formData.get("anniversary") === "on" ? "true" : "false",
    LIFECYCLE_WINBACK_ENABLED: formData.get("winback") === "on" ? "true" : "false",
  };
  for (const [key, value] of Object.entries(entries)) {
    await putSetting(key, value);
  }
  revalidatePath("/settings");
}

// ---- Email templates ----

export async function createTemplate(formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!name || !subject || !body) return;
  await prisma.emailTemplate.create({ data: { name, subject, body } });
  revalidatePath("/settings");
  revalidatePath("/campaigns");
}

export async function updateTemplate(id: string, formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!name || !subject || !body) return;
  await prisma.emailTemplate.update({ where: { id }, data: { name, subject, body } });
  revalidatePath("/settings");
}

export async function deleteTemplate(id: string, formData: FormData) {
  await requireOwner();
  void formData;
  await prisma.emailTemplate.delete({ where: { id } });
  revalidatePath("/settings");
}

/** Incoming-mail (IMAP) credentials — password encrypted at rest. */
export async function saveImapSettings(formData: FormData) {
  await requireOwner();
  const entries: Record<string, string> = {
    IMAP_HOST: String(formData.get("host") ?? "").trim(),
    IMAP_PORT: String(formData.get("port") ?? "993").trim(),
    IMAP_SECURE: formData.get("secure") === "on" ? "true" : "false",
    IMAP_USER: String(formData.get("user") ?? "").trim(),
    IMAP_PASS: String(formData.get("pass") ?? "").trim(),
  };
  for (const [key, value] of Object.entries(entries)) {
    await putSetting(key, value);
  }
  revalidatePath("/settings");
}
