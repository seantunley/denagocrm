"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { getSetting, putSetting } from "@/lib/settings";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import {
  EMAIL_HEADER_STYLES,
  SIGNING_EMAILS,
  isTextTemplate,
  parseEmailHeaderStyle,
  validateSigningTemplate,
  type SigningEmailKind,
  type StoredSigningTemplate,
} from "@/lib/signing/emailTemplates";
import { emailDocToText, sanitizeEmailDoc, type EmailDoc } from "@/lib/signing/emailDoc";
import { tenantEmailContent, tenantSmsContent } from "@/lib/signing/signingEmail";
import {
  CUSTOMER_RECORD_WRITE_PERMISSIONS,
  canAccessContact,
  canAccessLead,
  hasAnyPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import {
  signatureCompanyFrom,
  buildSignature,
  buildEmailHtml,
  htmlToText,
  parseSignatureDesign,
  SIGNATURE_DESIGN_KEY,
} from "@/lib/signature";
import { getCompanyProfile } from "@/lib/companyProfile";
import { readFile } from "@/lib/storage";
import { emailUploads } from "@/lib/emailUploads";
import { resolveActingTenant } from "@/lib/tenantContext";
import { parseReplyTo } from "@/lib/replyToAddresses";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { withActingStaffScope } from "@/lib/actingScope";

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
  // REFUSED, NOT SANITISED. This value reaches a mail header, where a CR or LF
  // would start a new one — so anything that is not a plain address list is
  // rejected outright. Quietly dropping the bad part would send mail whose replies
  // go somewhere the sender did not ask for and was never told about.
  const replyTo = parseReplyTo(String(formData.get("replyTo") ?? ""));
  if (!replyTo.ok) {
    return { error: `Reply-to is not a valid address list: ${replyTo.invalid.join(", ")}` };
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
  const design = parseSignatureDesign(await getSetting(SIGNATURE_DESIGN_KEY));
  const signature = buildSignature(user, signatureCompanyFrom(profile, await tenantOrigin(await tenantIdFor(user.id)), design));
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

  // Files uploaded from the computer (Sean, 2026-10-07: "must be able to upload
  // an attachment as well"). Checked before anything is sent; named on the
  // timeline and in the audit like library files.
  const uploads = emailUploads(formData);
  if ("error" in uploads) return { error: uploads.error };
  for (const file of uploads.files) {
    attachments.push({ filename: file.name, content: Buffer.from(await file.arrayBuffer()), contentType: file.type || undefined });
    attachedNames.push(file.name);
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
    replyTo: replyTo.value ?? undefined,
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
    // Where replies were directed is part of what was sent, and it is the one
    // detail nobody can recover afterwards — the message has left, and the header
    // exists only in the recipient's copy.
    summary: `Sent email to ${to}: “${subject}”${
      attachedNames.length > 0 ? ` (attached: ${attachedNames.join(", ")})` : ""
    }${replyTo.value ? ` (replies to: ${replyTo.value})` : ""}`,
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
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const result = await sendEmail({
      to: user.email,
      subject: "SMTP test email",
      text: "Your SMTP settings are working.",
    });
    return result.ok
      ? { ok: `Test email sent to ${user.email}.` }
      : { error: result.error };
  });
}

// ---- SMTP settings ----

export async function saveSmtpSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
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
    await requireTenantOwner();
    // Only the template. Whether reminders go out at all is the "Service-due
    // reminder" journey's switch now; SERVICE_REMINDER_ENABLED is left as it was
    // (the seeding reads it once as the owner's prior approval).
    await putSetting("SERVICE_REMINDER_TEMPLATE_ID", String(formData.get("templateId") ?? "").trim());
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
    const user = await requireTenantOwner();
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
    const user = await requireTenantOwner();
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
    const user = await requireTenantOwner();
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    void formData;
    await prisma.emailTemplate.deleteMany({ where: { id, tenantId } });
    revalidatePath("/settings");
    revalidatePath("/campaigns");
  });
}

// ---- Signing email templates (invitation / reminder / signed copy / code) ----

/**
 * The signing emails' overrides live in AppSetting under the tenant's own id,
 * written EXPLICITLY (not via ambient scope) because the send path reads them by
 * the signature request's tenantId from cron and public routes. Kept out of the
 * EmailTemplate table on purpose: that table feeds every campaign, journey and
 * service-reminder picker, and a signing template must never be picked as one.
 */
function signingKind(kind: string): SigningEmailKind {
  // Bound arguments of a server action arrive from the client — never trusted.
  if (!Object.hasOwn(SIGNING_EMAILS, kind)) refuse("Unknown signing email.");
  return kind as SigningEmailKind;
}

/**
 * The template the form describes: subject + either the formatted body (the
 * editor's JSON, sanitised here — never trusted from the browser) or a plain
 * body. The plain text is always DERIVED from the formatted body on the server,
 * so validation reads exactly what will be sent.
 */
function templateFromForm(kind: SigningEmailKind, formData: FormData): StoredSigningTemplate {
  const def = SIGNING_EMAILS[kind];
  const sms = isTextTemplate(def);
  // An SMS is plain text: no subject, never a formatted body.
  const subject = sms ? "" : String(formData.get("subject") ?? "").trim();
  const rawDoc = sms ? "" : String(formData.get("doc") ?? "");
  let doc: EmailDoc | null = null;
  if (rawDoc) {
    try {
      doc = sanitizeEmailDoc(JSON.parse(rawDoc), def.fields);
    } catch {
      refuse("The email body could not be read — reload the page and try again.");
    }
    if (!doc) refuse("The email body is empty or too long.");
  }
  const body = doc ? emailDocToText(doc) : String(formData.get("body") ?? "").replace(/\r\n?/g, "\n").trim();
  const problem = validateSigningTemplate(def.kind, subject, body);
  if (problem) refuse(problem);
  return doc ? { subject, body, doc } : { subject, body };
}

export async function saveSigningEmailTemplate(kind: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const def = SIGNING_EMAILS[signingKind(kind)];
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const value = JSON.stringify(templateFromForm(def.kind, formData));
    await basePrisma.appSetting.upsert({
      where: { tenantId_key: { tenantId, key: def.settingKey } },
      update: { value },
      create: { tenantId, key: def.settingKey, value },
    });
    await logAudit({ action: "settings.signing_email.saved", summary: `Edited the “${def.label}” message template`, user });
    revalidatePath("/settings");
  });
}

export async function resetSigningEmailTemplate(kind: string, formData: FormData) {
  return asActionResult(async () => {
    void formData;
    const user = await requireTenantOwner();
    const def = SIGNING_EMAILS[signingKind(kind)];
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    await basePrisma.appSetting.deleteMany({ where: { tenantId, key: def.settingKey } });
    await logAudit({ action: "settings.signing_email.reset", summary: `Reset the “${def.label}” message template to default`, user });
    revalidatePath("/settings");
  });
}

/** Header background for the branded emails (signing, quote, and the other system emails). */
export async function saveEmailHeaderStyle(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const raw = String(formData.get("headerStyle") ?? "");
    if (!Object.hasOwn(EMAIL_HEADER_STYLES, raw)) refuse("Choose a header style.");
    const style = parseEmailHeaderStyle(raw);
    await basePrisma.appSetting.upsert({
      where: { tenantId_key: { tenantId, key: "EMAIL_HEADER_STYLE" } },
      update: { value: style },
      create: { tenantId, key: "EMAIL_HEADER_STYLE", value: style },
    });
    await logAudit({ action: "settings.email_header.saved", summary: `Set the email header to ${EMAIL_HEADER_STYLES[style]}`, user });
    revalidatePath("/settings");
  });
}

/** The workspace's email signature design — one for everyone (lib/signature.ts SignatureDesign). */
export async function saveSignatureDesign(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const design = parseSignatureDesign(
      JSON.stringify({
        style: formData.get("style"),
        companyLine: String(formData.get("companyLine") ?? "").replace(/[\r\n]+/g, " "),
        footerLine: String(formData.get("footerLine") ?? "").replace(/[\r\n]+/g, " "),
      }),
    );
    const value = JSON.stringify(design);
    await basePrisma.appSetting.upsert({
      where: { tenantId_key: { tenantId, key: SIGNATURE_DESIGN_KEY } },
      update: { value },
      create: { tenantId, key: SIGNATURE_DESIGN_KEY, value },
    });
    await logAudit({
      action: "settings.email_signature.saved",
      summary: `Set the email signature to the ${design.style === "card" ? "card" : "classic"} design`,
      user,
    });
    revalidatePath("/settings");
  });
}

/** Sample values for the live preview — obviously fake, so a preview can't be mistaken for a real send. */
const PREVIEW_VARS: Record<string, string> = {
  recipient_name: "Jane Doe",
  first_name: "Jane",
  document_title: "Quote Q-1026",
  quote_number: "Q-1026",
  expiry_date: "14 Oct 2026",
  code: "482913",
  total: "R 125 000,00",
  model: "Rover XL",
  item: "Rover XL",
  due_date: "14 Oct 2026",
  recall_title: "Brake cable inspection",
  recall_description: "We're checking the rear brake cable on all Rover XL vehicles built before June 2026.",
  review_link: "https://search.google.com/local/writereview?placeid=preview-only",
  survey_title: "Service feedback",
  survey_intro: "We'd love to hear how your service went.",
  survey_subject: "How was your service? A quick question ⭐",
};

export type EmailPreview = { subject?: string; html?: string; text?: string; error?: string };

/**
 * The live preview in Settings → Email templates: the unsaved draft, rendered
 * exactly as it would be sent — this workspace's logo, colour, footer and
 * button — with sample values. Nothing is stored or sent.
 */
export async function previewSigningEmailTemplate(kind: string, formData: FormData): Promise<EmailPreview> {
  let preview: EmailPreview = {};
  const result = await asActionResult(async () => {
    const user = await requireTenantOwner();
    const k = signingKind(kind);
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const draft = templateFromForm(k, formData);
    const origin = (await tenantOrigin(tenantId)) || "";
    const vars = {
      ...PREVIEW_VARS,
      sender_name: user.name ?? "",
      signing_link: `${origin}/signing/preview-only-not-a-real-link`,
      survey_link: `${origin}/s/preview-only`,
    };
    if (isTextTemplate(SIGNING_EMAILS[k])) {
      preview = { text: await tenantSmsContent(k, tenantId, vars, draft) };
      return;
    }
    const rendered = await tenantEmailContent(k, tenantId, vars, draft);
    preview = { subject: rendered.subject, html: rendered.html };
  });
  return result.error ? { error: result.error } : preview;
}

/** Incoming-mail (IMAP) credentials — password encrypted at rest. */
export async function saveImapSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
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
