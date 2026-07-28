"use server";

import { asActionResult } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { putSetting } from "@/lib/settings";
import { requireCrmOrWorkshop, requireOwner } from "@/lib/auth";
import { canAccessContact, canAccessLead, hasAnyPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { buildSignature, buildEmailHtml, htmlToText } from "@/lib/signature";
import { readFile } from "@/lib/storage";
import { resolveActingTenant } from "@/lib/tenantContext";

export type SendEmailState = { ok?: string; error?: string };

async function tenantIdFor(userId: string): Promise<string | null> {
  const tenant = await resolveActingTenant(userId);
  return "tenantId" in tenant ? tenant.tenantId : null;
}

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
  // Don't let a caller log an email against — or pull context from — a contact or
  // lead they can't access. (`to` stays free-form: the CRM legitimately emails
  // addresses that aren't the record's stored email.)
  if (contactId && !(await canAccessContact(user, contactId))) {
    return { error: "You don't have access to that contact." };
  }
  if (leadId && !(await canAccessLead(user, leadId))) {
    return { error: "You don't have access to that lead." };
  }
  const signature = buildSignature(user);
  const html = buildEmailHtml(bodyHtml, signature);

  // Library attachments (selected version ids)
  const attachIds = formData.getAll("attach").map(String).filter(Boolean);
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  const attachedNames: string[] = [];
  if (attachIds.length > 0) {
    // Gate the document library — otherwise any crm/workshop user could read
    // arbitrary library files off storage and exfiltrate them as attachments to
    // any address. Also exclude trashed documents.
    if (!(await hasAnyPermission(user, "library.view", "library.manage"))) {
      return { error: "You don't have access to the document library." };
    }
    const versions = await prisma.libraryVersion.findMany({
      where: { id: { in: attachIds }, document: { deletedAt: null } },
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
  return asActionResult(async () => {
    await requireOwner();
    const entries: Record<string, string> = {
      SMTP_HOST: String(formData.get("host") ?? "").trim(),
      SMTP_PORT: String(formData.get("port") ?? "587").trim(),
      SMTP_SECURE: formData.get("secure") === "on" ? "true" : "false",
      SMTP_USER: String(formData.get("user") ?? "").trim(),
      SMTP_FROM: String(formData.get("from") ?? "").trim(),
    };
    // The password field renders blank (never echoes the stored secret), so a
    // blank submit means "keep the saved password" — only overwrite when provided.
    const pass = String(formData.get("pass") ?? "").trim();
    if (pass) entries.SMTP_PASS = pass;
    for (const [key, value] of Object.entries(entries)) {
      await putSetting(key, value);
    }
    revalidatePath("/settings");
  });
}

export async function saveServiceReminderSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const entries: Record<string, string> = {
      SERVICE_REMINDER_ENABLED: formData.get("enabled") === "on" ? "true" : "false",
      SERVICE_REMINDER_TEMPLATE_ID: String(formData.get("templateId") ?? "").trim(),
    };
    for (const [key, value] of Object.entries(entries)) {
      await putSetting(key, value);
    }
    revalidatePath("/settings");
  });
}

export async function saveLifecycleSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const entries: Record<string, string> = {
      LIFECYCLE_ANNIVERSARY_ENABLED: formData.get("anniversary") === "on" ? "true" : "false",
      LIFECYCLE_WINBACK_ENABLED: formData.get("winback") === "on" ? "true" : "false",
    };
    for (const [key, value] of Object.entries(entries)) {
      await putSetting(key, value);
    }
    revalidatePath("/settings");
  });
}

// ---- Email templates ----

export async function createTemplate(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return;
    const name = String(formData.get("name") ?? "").trim();
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    if (!name || !subject || !body) return;
    await prisma.emailTemplate.create({ data: { tenantId, name, subject, body } });
    revalidatePath("/settings");
    revalidatePath("/campaigns");
  });
}

export async function updateTemplate(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return;
    const name = String(formData.get("name") ?? "").trim();
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    if (!name || !subject || !body) return;
    await prisma.emailTemplate.updateMany({
      where: { id, tenantId },
      data: { name, subject, body },
    });
    revalidatePath("/settings");
    revalidatePath("/campaigns");
  });
}

export async function deleteTemplate(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return;
    void formData;
    await prisma.emailTemplate.deleteMany({ where: { id, tenantId } });
    revalidatePath("/settings");
    revalidatePath("/campaigns");
  });
}

/** Incoming-mail (IMAP) credentials — password encrypted at rest. */
export async function saveImapSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const entries: Record<string, string> = {
      IMAP_HOST: String(formData.get("host") ?? "").trim(),
      IMAP_PORT: String(formData.get("port") ?? "993").trim(),
      IMAP_SECURE: formData.get("secure") === "on" ? "true" : "false",
      IMAP_USER: String(formData.get("user") ?? "").trim(),
    };
    // Blank password submit = keep the saved one (the field never echoes it back).
    const pass = String(formData.get("pass") ?? "").trim();
    if (pass) entries.IMAP_PASS = pass;
    for (const [key, value] of Object.entries(entries)) {
      await putSetting(key, value);
    }
  });
}
