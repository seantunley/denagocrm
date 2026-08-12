"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { putSetting } from "@/lib/settings";
import { requireOwner } from "@/lib/auth";
import {
  CUSTOMER_RECORD_WRITE_PERMISSIONS,
  canAccessContact,
  canAccessLead,
  hasAnyPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { signatureCompanyFrom, buildSignature, buildEmailHtml, htmlToText } from "@/lib/signature";
import { getCompanyProfile } from "@/lib/companyProfile";
import { readFile } from "@/lib/storage";
import { resolveActingTenant } from "@/lib/tenantContext";
import { tenantOrigin } from "@/lib/tenantOrigin";

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
  // Write grade. This SENDS MAIL from the workspace's own address, with the
  // caller's signature, to a free-form recipient — and logs a Communication. It
  // was gated on the VIEW list, so a read-only rep could send on the company's
  // behalf. Sending is not a read, whatever the record gate says.
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
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
  const profile = await getCompanyProfile();
  const signature = buildSignature(user, signatureCompanyFrom(profile, await tenantOrigin(await tenantIdFor(user.id))));
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
    // The plain-text alternative every client falls back to, and the one place
    // the company was still named by a literal after the HTML signature stopped
    // doing it. It carried Denago's trading name and landline out of every
    // workspace. Built from the same profile the HTML signature uses, with empty
    // parts dropped rather than left as dangling separators.
    text: `${bodyText}\n\n--\n${[user.name, profile.name, profile.phone].filter((s) => s && s.trim()).join(" · ")}`,
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
      tenantId: await customerRecordTenantId({ contactId, leadId }),
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

// saveLifecycleSettings was removed with the hardcoded lifecycleJourneys engine
// it configured. Anniversary and win-back are Journey triggers now
// (purchase_anniversary / win_back on /journeys); leaving a writer for
// LIFECYCLE_ANNIVERSARY_ENABLED behind would let someone switch a setting that
// nothing reads.

// ---- Email templates ----

export async function createTemplate(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const name = String(formData.get("name") ?? "").trim();
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    if (!name || !subject || !body) refuse("Name, subject and body are all required.");
    await prisma.emailTemplate.create({ data: { tenantId, name, subject, body } });
    revalidatePath("/settings");
    revalidatePath("/campaigns");
  });
}

export async function updateTemplate(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const name = String(formData.get("name") ?? "").trim();
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    if (!name || !subject || !body) refuse("Name, subject and body are all required.");
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
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
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
