"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { formatDate } from "@/lib/format";
import { picturesIn, sendWarning } from "@/lib/sendCheck";
import { secureLinkDays, secureLinkExpiry, secureLinksHtml } from "@/lib/secureLinks";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { putSetting } from "@/lib/settings";
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
  requireAnyPermission,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import {
  htmlToText,
  parseSignatureDesign,
  SIGNATURE_DESIGN_KEY,
  type SignatureDesign,
} from "@/lib/signature";
import { getCompanyProfile } from "@/lib/companyProfile";
import { savePublicAsset, storesPrivately } from "@/lib/storage";

import { MAX_LOGO_BYTES } from "@/lib/emailInlineLogo";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { withActingStaffScope } from "@/lib/actingScope";
import { EMAIL_OPEN_TRACKING_KEY } from "@/lib/emailOpenTracking";
import { MESSAGE_PLACES } from "@/lib/customerMessagePlaces";
import { bannersForSender } from "@/lib/signatureBannerStore";
import { composerHtml, customerAddresses, NO_PRIVATE_STORE, sendComposerForm, tenantIdFor, type ComposerRecipient } from "@/lib/composerSend";
import { cancelScheduled, draftsOnRecord, finishDraft, openDraft, saveDraft, scheduleComposerEmail, type DraftFields, type DraftSummary } from "@/lib/emailDrafts";

export type SendEmailState = { ok?: string; error?: string };

/** The composer's autosave (lib/emailDrafts.ts): the author's own draft, kept as it is written. */
export async function saveEmailDraft(id: string | null, fields: Partial<DraftFields>): Promise<{ id?: string; error?: string }> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  return saveDraft(user, id ? String(id).slice(0, 64) : null, fields ?? {});
}

/** Discard the author's own draft. */
export async function discardEmailDraft(id: string): Promise<void> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  await finishDraft(user, String(id).slice(0, 64));
}

/** What waits on this record: the caller's drafts, and every scheduled send on it. */
export async function emailDraftsOnRecord(record: { contactId?: string | null; leadId?: string | null }): Promise<DraftSummary[]> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  return draftsOnRecord(user, record?.contactId ? String(record.contactId) : null, record?.leadId ? String(record.leadId) : null);
}

/** Open the caller's draft — or take back their scheduled send to edit it. */
export async function openEmailDraft(id: string) {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  return openDraft(user, String(id).slice(0, 64));
}

/** Cancel a scheduled send (its author, or the owner). */
export async function cancelScheduledEmail(id: string, revalidate: string): Promise<{ error?: string }> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  const result = await cancelScheduled(user, String(id).slice(0, 64));
  if (!result.error) revalidatePath(String(revalidate || "/"));
  return result;
}

/**
 * The banners the person writing may put on this email (Settings → Signature
 * banners decides which are theirs), the default first. Empty = no picker.
 * They choose among what the owner switched on, or none; nothing else.
 */
export async function composerBannerChoices(): Promise<{ id: string; name: string }[]> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return [];
  return (await bannersForSender(tenantId, user.id).catch(() => [])).map(({ id, name }) => ({ id, name }));
}

/**
 * The composer's Preview (Sean, 2026-10-07: "a preview on the email, to view before it sends"). Sends nothing.
 *
 * `recipient`: who it is going to and the banner the sender picked, so the
 * preview carries the same signature banner the email will (or none, for a
 * customer who opted out of marketing).
 *
 * `secureFiles`: files that will go as secure links rather than attachments.
 * The preview shows the same block the email will carry, with links that lead
 * nowhere — real links are only made when the email is actually sent.
 */
export async function previewComposerEmail(
  bodyHtml: string,
  recipient: ComposerRecipient = {},
  secureFiles?: { files: { name: string; sizeBytes: number }[]; days: number },
): Promise<{ html: string }> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  // Only records the caller may open decide anything here — the same rule Send applies.
  const contactId = recipient.contactId && (await canAccessContact(user, recipient.contactId)) ? recipient.contactId : null;
  const leadId = recipient.leadId && (await canAccessLead(user, recipient.leadId)) ? recipient.leadId : null;
  const to = String(recipient.to ?? "").slice(0, 1000);
  const choice = String(recipient.choice ?? "").slice(0, 64);
  const files = (secureFiles?.files ?? []).slice(0, 20).map((file) => ({ name: String(file.name).slice(0, 200), sizeBytes: Number(file.sizeBytes) || 0, url: "#" }));
  const block = files.length ? secureLinksHtml(files, formatDate(secureLinkExpiry(new Date(), secureLinkDays(secureFiles?.days)))) : "";
  const { html } = await composerHtml(user, String(bodyHtml ?? "").trim() + block, await getCompanyProfile(), { to, contactId, leadId, choice }, true);
  return { html };
}


/**
 * The check before an email goes (lib/sendCheck.ts): does it carry an ID number,
 * bank or card details, or a personal document, to an address that is not on
 * this customer's record? The composer asks this when Send is pressed and shows
 * the answer; sendEmailAction asks it again and refuses unless it was confirmed,
 * so the warning cannot be skipped by a stale or altered page.
 */
export async function checkComposerEmail(input: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyHtml: string;
  contactId?: string | null;
  leadId?: string | null;
  fileNames: string[];
  secureLinks: boolean;
}): Promise<{ warning: string | null; error?: string }> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  if (input.secureLinks && !storesPrivately()) return { warning: null, error: NO_PRIVATE_STORE };
  const warning = sendWarning({
    subject: String(input.subject ?? "").slice(0, 500),
    bodyText: htmlToText(String(input.bodyHtml ?? "")).slice(0, 100_000),
    fileNames: (input.fileNames ?? []).slice(0, 30).map((name) => String(name).slice(0, 200)),
    secureLinks: Boolean(input.secureLinks),
    // Everyone it goes to — To, Cc and Bcc — as Send asks it.
    to: [input.to, input.cc, input.bcc].map((list) => String(list ?? "").slice(0, 1000)).filter(Boolean).join(", "),
    customerAddresses: await customerAddresses(user, input.contactId || null, input.leadId || null),
    // Pictures in the message: what they show cannot be read, so they are asked about too (review of #886).
    pictures: picturesIn(String(input.bodyHtml ?? "")),
  });
  return { warning: warning?.text ?? null };
}

/**
 * Recall a secure link: it stops working at once, and the customer who opens it
 * is told the file was withdrawn. For anyone who may write to the customer the
 * link was sent to. It cannot be undone — send the file again instead.
 */
export async function recallSecureLink(id: string): Promise<{ error?: string }> {
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return { error: "No workspace attached to this sign-in — sign out and back in." };
  // The caller's permission says what they may do; the row says whose it is.
  const link = await prisma.secureFileLink.findFirst({ where: { id: String(id), tenantId }, select: { id: true, fileName: true, contactId: true, leadId: true, revokedAt: true } });
  if (!link) return { error: "That link no longer exists." };
  if (link.contactId && !(await canAccessContact(user, link.contactId))) return { error: "You don't have access to that contact." };
  if (link.leadId && !(await canAccessLead(user, link.leadId))) return { error: "You don't have access to that lead." };
  if (!link.revokedAt) {
    await prisma.secureFileLink.updateMany({ where: { id: link.id, tenantId, revokedAt: null }, data: { revokedAt: new Date(), revokedById: user.id } });
    await logAudit({ action: "secure_link.recalled", summary: `Recalled the secure link for “${link.fileName}”`, contactId: link.contactId, leadId: link.leadId, user });
  }
  if (link.leadId) revalidatePath(`/leads/${link.leadId}`);
  if (link.contactId) revalidatePath(`/contacts/${link.contactId}`);
  return {};
}

/**
 * Sends an email and logs it as an outbound communication on the lead/contact —
 * or, with `sendAt`, schedules it (lib/emailDrafts.ts). The work is
 * lib/composerSend.ts, shared with the scheduled-emails cron.
 */
export async function sendEmailAction(
  _prev: SendEmailState | undefined,
  formData: FormData
): Promise<SendEmailState> {
  // Write grade. This SENDS MAIL from the workspace's own address, with the
  // caller's signature, to a free-form recipient — and logs a Communication. It
  // was gated on the VIEW list, so a read-only rep could send on the company's
  // behalf. Sending is not a read, whatever the record gate says.
  const user = await requireAnyPermission(...CUSTOMER_RECORD_WRITE_PERMISSIONS);
  // Only ever a flag the cron sets on a form it builds itself; never taken from a browser.
  formData.delete("scheduledSend");
  const draftId = String(formData.get("draftId") ?? "").trim().slice(0, 64) || null;
  const when = String(formData.get("sendAt") ?? "").trim();
  if (when) {
    const scheduled = await scheduleComposerEmail(user, formData, when, draftId);
    if (scheduled.ok) revalidatePath(String(formData.get("revalidate") ?? "/"));
    return scheduled;
  }
  const { ok, error } = await sendComposerForm(user, formData);
  // Sent: the draft it was written in is done with.
  if (ok && draftId) await finishDraft(user, draftId).catch(() => {});
  return ok ? { ok } : { error };
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
    revalidateMessagePlaces();
  });
}

/** A message's editor lives on Document Studio, Journeys → Customer messages or Settings (customerMessagePlaces.ts). */
function revalidateMessagePlaces() {
  for (const { path } of Object.values(MESSAGE_PLACES)) revalidatePath(path.split("?")[0]);
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
    revalidateMessagePlaces();
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

/** Settings → Email: whether composer and quote emails carry the open-tracking image. */
export async function saveEmailOpenTracking(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const value = formData.get("openTracking") === "off" ? "off" : "on";
    await basePrisma.appSetting.upsert({
      where: { tenantId_key: { tenantId, key: EMAIL_OPEN_TRACKING_KEY } },
      update: { value },
      create: { tenantId, key: EMAIL_OPEN_TRACKING_KEY, value },
    });
    await logAudit({ action: "settings.email_open_tracking.saved", summary: `Turned email open tracking ${value}`, user });
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
        // The banner is set by its own buttons (saveSignatureBanner); a Save keeps it.
        bannerUrl: (await storedSignatureDesign(tenantId)).bannerUrl,
      }),
    );
    await storeSignatureDesign(tenantId, design);
    await logAudit({
      action: "settings.email_signature.saved",
      summary: `Set the email signature to the ${design.style === "card" ? "card" : "classic"} design`,
      user,
    });
    revalidatePath("/settings");
  });
}

const storedSignatureDesign = async (tenantId: string) =>
  parseSignatureDesign(
    (await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: SIGNATURE_DESIGN_KEY } }, select: { value: true } }))?.value,
  );

async function storeSignatureDesign(tenantId: string, design: SignatureDesign) {
  const value = JSON.stringify(design);
  await basePrisma.appSetting.upsert({
    where: { tenantId_key: { tenantId, key: SIGNATURE_DESIGN_KEY } },
    update: { value },
    create: { tenantId, key: SIGNATURE_DESIGN_KEY, value },
  });
}

// The email embedder's own limit (review of #804): a bigger banner would show in
// the Settings preview but stay a remote image in the sent email, which many mail
// apps block — the panel would be missing for exactly the customers who matter.
const BANNER_MAX_BYTES = MAX_LOGO_BYTES;

/**
 * The card signature's logo panel image: drawn in the browser from the logo
 * ("Generate from my logo", lib/signatureBanner.ts) or the owner's own file.
 * Stored as a PUBLIC asset — it is email artwork every recipient's mail app
 * loads — and embedded in each email by emailInlineLogo.ts. Sending no file
 * removes it, back to the plainer panel.
 */
export async function saveSignatureBanner(formData: FormData): Promise<{ error?: string; bannerUrl?: string }> {
  let bannerUrl = "";
  const result = await asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await getActiveTenantId();
    if (!tenantId) refuse("No workspace attached to this sign-in — sign out and back in.");
    const file = formData.get("banner");
    if (file instanceof File && file.size > 0) {
      if (!["image/png", "image/jpeg"].includes(file.type)) refuse("The banner has to be a PNG or JPG image.");
      if (file.size > BANNER_MAX_BYTES) refuse("The banner is over the 1 MB limit — save it smaller (960 × 300 is plenty).");
      bannerUrl = await savePublicAsset(Buffer.from(await file.arrayBuffer()), file.type === "image/png" ? "signature-banner.png" : "signature-banner.jpg", file.type, tenantId);
      // Without a public store the file lands on local disk with no web address,
      // and a mail app can't load a banner that has none.
      if (!/^https:\/\//i.test(bannerUrl)) refuse("Images can't be stored publicly here — file storage isn't set up.");
    }
    const design = { ...(await storedSignatureDesign(tenantId)), bannerUrl };
    // parse → the same https-only rule the send path applies.
    await storeSignatureDesign(tenantId, parseSignatureDesign(JSON.stringify(design)));
    await logAudit({
      action: "settings.email_signature.banner",
      summary: bannerUrl ? "Set the email signature's logo panel image" : "Removed the email signature's logo panel image",
      user,
    });
    revalidatePath("/settings");
  });
  return result.error ? { error: result.error } : { bannerUrl };
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
