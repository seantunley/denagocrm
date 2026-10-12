"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { formatDate } from "@/lib/format";
import { redactSensitive, sendWarning } from "@/lib/sendCheck";
import { secureLinkDays, secureLinkExpiry, secureLinksHtml, secureLinksText } from "@/lib/secureLinks";
import { attachSecureLinksToEmail, createSecureLinks, discardSecureLinks, type SecureFile } from "@/lib/secureLinkStore";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { postedDealId } from "@/lib/customerTimeline";
import { resolveFiling } from "@/lib/customerTimelineFiling";
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
  canAccessQuote,
  hasAnyPermission,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { quotePdfFileName } from "@/lib/quoteEmail";
import { markQuoteSentIfDraft, quotePdf, recordQuoteEmailed } from "@/lib/quoteEmailSend";
import { COMPOSER_QUOTE_STATUSES } from "@/lib/composerQuotes";
import { emitQuoteJourneyEvent } from "@/lib/leadJourneyEvents";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import {
  signatureCompanyFrom,
  buildSignature,
  buildEmailHtml,
  htmlToText,
  parseSignatureDesign,
  SIGNATURE_DESIGN_KEY,
  type SignatureDesign,
} from "@/lib/signature";
import { getCompanyProfile } from "@/lib/companyProfile";
import { isPublicBlobRef, readFile, saveFile, savePublicAsset, storesPrivately } from "@/lib/storage";

/**
 * A secure link promises to expire and to be recallable. A file in the public
 * Blob store has a URL of its own that neither promise reaches, so a secure
 * link is only made where files are stored privately. Said before anything is
 * stored or sent.
 */
/** Each attached quote is a PDF rendered during the send; a handful is plenty for one email. */
const MAX_QUOTES_PER_EMAIL = 5;

const NO_PRIVATE_STORE =
  "Secure links need the private file store, which is not switched on for this CRM. Nothing was sent — untick “Send as a secure link” to attach the files instead.";
import { MAX_LOGO_BYTES } from "@/lib/emailInlineLogo";
import { emailUploads } from "@/lib/emailUploads";
import { resolveActingTenant } from "@/lib/tenantContext";
import { parseReplyTo } from "@/lib/replyToAddresses";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { withActingStaffScope } from "@/lib/actingScope";
import { EMAIL_OPEN_TRACKING_KEY } from "@/lib/emailOpenTracking";
import { MESSAGE_PLACES } from "@/lib/customerMessagePlaces";
import { bannerClickUrl, bannerHtml, bannerPosition } from "@/lib/signatureBanners";
import { LEGAL_LINE_KEY, htmlWithLegalLine } from "@/lib/emailLegalLine";
import { bannerForEmail, bannersForSender, recordBannerSent } from "@/lib/signatureBannerStore";

export type SendEmailState = { ok?: string; error?: string };

async function tenantIdFor(userId: string): Promise<string | null> {
  const tenant = await resolveActingTenant(userId);
  return "tenantId" in tenant ? tenant.tenantId : null;
}

type ComposerUser = Awaited<ReturnType<typeof requireAnyPermission>>;

/** `choice`: the banner the sender picked in the composer — an id, "none", or blank for the default. */
type ComposerRecipient = { to?: string; contactId?: string | null; leadId?: string | null; choice?: string | null };

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
 * The composer email's HTML: the message, the sender's signature, and under it
 * the signature banner that is live for this sender (Settings → Signature
 * banners) — unless the recipient opted out of marketing. One builder, so
 * Preview is what Send sends; only the banner's LINK differs (`preview`), so
 * that trying it in the preview is not counted as a customer's click.
 */
async function composerHtml(
  user: ComposerUser,
  bodyHtml: string,
  profile: Awaited<ReturnType<typeof getCompanyProfile>>,
  recipient: ComposerRecipient = {},
  preview = false,
): Promise<{ html: string; tenantId: string | null; bannerId: string | null }> {
  // The workspace's signature design (Settings → My account → Email signature), same as the settings preview.
  const design = parseSignatureDesign(await getSetting(SIGNATURE_DESIGN_KEY));
  const tenantId = await tenantIdFor(user.id);
  const company = signatureCompanyFrom(profile, await tenantOrigin(tenantId), design);
  // The banner's link is on the same origin as the signature's own images: the workspace's.
  const origin = company.assetBase;
  // Never a reason to lose the email: a banner that can't be worked out is an email without one.
  const banner = tenantId ? await bannerForEmail({ tenantId, senderId: user.id, ...recipient }).catch(() => null) : null;
  const marketing = banner ? bannerHtml(banner, preview ? banner.linkUrl : bannerClickUrl(origin, banner.token)) : "";
  // Under the signature, or — the owner's choice per banner — at the top of the email, above the message.
  const above = Boolean(banner) && bannerPosition(banner!.position) === "above";
  const built = buildEmailHtml(bodyHtml, buildSignature(user, company) + (above ? "" : marketing));
  const html = above ? built.replace(/<body[^>]*>/i, (open) => `${open}${marketing}`) : built;
  // The legal line is added to every email where it leaves (lib/email.ts). A preview never gets
  // there, so it is added here for the preview alone — or Preview would not be what Send sends.
  const legalLine = preview ? await getSetting(LEGAL_LINE_KEY).catch(() => null) : null;
  return { html: legalLine ? htmlWithLegalLine(html, legalLine) : html, tenantId, bannerId: banner?.id ?? null };
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

/** The addresses already on the customer record this email is filed on — only for records the caller may open. */
async function customerAddresses(user: ComposerUser, contactId: string | null, leadId: string | null): Promise<string[]> {
  const [contact, lead] = await Promise.all([
    contactId && (await canAccessContact(user, contactId)) ? prisma.contact.findUnique({ where: { id: contactId }, select: { email: true } }) : null,
    leadId && (await canAccessLead(user, leadId)) ? prisma.lead.findUnique({ where: { id: leadId }, select: { email: true, contact: { select: { email: true } } } }) : null,
  ]);
  return [contact?.email, lead?.email, lead?.contact?.email].filter((address): address is string => Boolean(address?.trim()));
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
    to: String(input.to ?? "").slice(0, 1000),
    customerAddresses: await customerAddresses(user, input.contactId || null, input.leadId || null),
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
  // "The customer in general" (DealField's last option) is no deal.
  const postedLeadId = postedDealId(formData.get("leadId"));
  const postedContactId = String(formData.get("contactId") ?? "").trim() || null;

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
  if (postedContactId && !(await canAccessContact(user, postedContactId))) {
    return { error: "You don't have access to that contact." };
  }
  if (postedLeadId && !(await canAccessLead(user, postedLeadId))) {
    return { error: "You don't have access to that lead." };
  }
  // ONE TIMELINE: an email on a deal also carries the deal's customer, and a deal
  // chosen on a customer's page must be THAT customer's (lib/customerTimeline).
  const filing = await resolveFiling({ leadId: postedLeadId, contactId: postedContactId });
  if (!filing.ok) return { error: filing.error };
  const { contactId, leadId } = filing;
  const profile = await getCompanyProfile();
  // The sender's pick of banner for this one email (or "none"); only ever among the banners that are theirs.
  const choice = String(formData.get("banner") ?? "").slice(0, 64);
  // Send the files as secure links instead of attachments (lib/secureLinks.ts):
  // the file stays in our store, the email carries a link that expires and can be recalled.
  const asSecureLinks = formData.get("secureLinks") === "on";
  const secureFiles: SecureFile[] = [];
  // Uploads to store for a secure link — only once every check below has passed.
  const secureUploads: { name: string; type: string; size: number; buffer: Buffer }[] = [];

  // Library attachments (selected version ids)
  const attachIds = formData.getAll("attach").map(String).filter(Boolean);
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  const attachedNames: string[] = [];
  // The files' own names, for the check before sending (lib/sendCheck.ts).
  const fileNames: string[] = [];
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
      fileNames.push(v.fileName);
      attachedNames.push(`${v.document.name} (v${v.version})`);
      // As a secure link the library's own stored file is pointed at; nothing is read or copied —
      // unless that file sits in the PUBLIC store (uploaded before the private one was switched
      // on). Its own URL would outlive the link, so a private copy is made and linked instead.
      if (asSecureLinks && isPublicBlobRef(v.storedName)) {
        try {
          const buffer = await readFile(v.storedName);
          secureUploads.push({ name: v.fileName, type: v.mimeType, size: buffer.length, buffer });
        } catch {
          return { error: `“${v.fileName}” could not be read from storage.` };
        }
        continue;
      }
      if (asSecureLinks) {
        secureFiles.push({ fileName: v.fileName, storedRef: v.storedName, mimeType: v.mimeType, sizeBytes: v.sizeBytes });
        continue;
      }
      try {
        attachments.push({
          filename: v.fileName,
          content: await readFile(v.storedName),
          contentType: v.mimeType,
        });
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
    const buffer = Buffer.from(await file.arrayBuffer());
    fileNames.push(file.name);
    attachedNames.push(file.name);
    if (asSecureLinks) secureUploads.push({ name: file.name, type: file.type || "application/octet-stream", size: buffer.length, buffer });
    else attachments.push({ filename: file.name, content: buffer, contentType: file.type || undefined });
  }
  // QUOTES ATTACHED FROM THE COMPOSER ("Attach quote"). The same PDF "Email quote"
  // sends, under the same permission on the same quote — and, further down, the
  // same consequence: a draft that has gone to the customer is a sent quote. An
  // email with the quote PDF uploaded by hand could not be told from any other
  // file, so the quote stayed a draft after the customer had it.
  const quoteIds = [...new Set(formData.getAll("attachQuote").map(String).filter(Boolean))];
  const sentQuotes: { id: string; number: number; updatedAt: Date; leadId: string | null; contactId: string | null; tenantId: string | null }[] = [];
  if (quoteIds.length > MAX_QUOTES_PER_EMAIL) return { error: `Attach at most ${MAX_QUOTES_PER_EMAIL} quotes to one email.` };
  if (quoteIds.length > 0 && !(await hasPermission(user, "quotes.change_status"))) {
    return { error: "Your role can't send quotes to customers." };
  }
  for (const quoteId of quoteIds) {
    if (!(await canAccessQuote(user, quoteId))) return { error: "You don't have access to that quote." };
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      select: {
        id: true, number: true, status: true, updatedAt: true, deletedAt: true, supersededAt: true, leadId: true, contactId: true, tenantId: true,
        _count: { select: { items: true } },
      },
    });
    if (!quote || quote.deletedAt) return { error: "That quote no longer exists." };
    // The composer does not OFFER a declined or cancelled quote — but that list is
    // drawn in the browser, and an id can be posted without it. The same list,
    // enforced here.
    if (!COMPOSER_QUOTE_STATUSES.includes(quote.status)) {
      return { error: `Quote Q-${quote.number} is ${quote.status} — it can't be sent to the customer. Nothing was sent.` };
    }
    // Only this customer's quotes: the composer is open on one lead or one customer,
    // and the email is logged there. Another customer's quote does not belong in it.
    const theirs = (leadId && quote.leadId === leadId) || (contactId && quote.contactId === contactId);
    if (!theirs) return { error: `Quote Q-${quote.number} belongs to a different customer.` };
    // AN EMAIL ON ONE DEAL DOES NOT CARRY ANOTHER DEAL'S QUOTE. The customer can
    // have several deals, and the email is filed on the one it was written about:
    // attaching deal B's quote to an email filed on deal A would put B's quotation
    // on A's history, and mark B's quote sent from a conversation about A. A
    // quote that is on no deal (made for the customer directly) may go with any.
    if (leadId && quote.leadId && quote.leadId !== leadId) {
      return { error: `Quote Q-${quote.number} belongs to a different deal of this customer — send it from that deal, or choose that deal for this email. Nothing was sent.` };
    }
    if (quote.supersededAt) return { error: `Quote Q-${quote.number} has been replaced by a revision — attach the latest one.` };
    if (quote._count.items === 0) return { error: `Add at least one line to quote Q-${quote.number} before sending it.` };
    const pdf = await quotePdf(quote.id);
    if (!pdf) return { error: `The PDF for quote Q-${quote.number} could not be generated. Nothing was sent.` };
    const name = quotePdfFileName(quote.number);
    fileNames.push(name);
    attachedNames.push(name);
    if (asSecureLinks) secureUploads.push({ name, type: "application/pdf", size: pdf.length, buffer: pdf });
    else attachments.push({ filename: name, content: pdf, contentType: "application/pdf" });
    sentQuotes.push(quote);
  }

  const secure = asSecureLinks && fileNames.length > 0;
  if (secure && !storesPrivately()) return { error: NO_PRIVATE_STORE };

  // THE CHECK BEFORE IT GOES (lib/sendCheck.ts). The composer asks this when Send
  // is pressed and shows the warning; here it is asked again, and an email that
  // would be warned about is refused unless the sender confirmed it. Before any
  // file is stored or any link is made.
  const warning = sendWarning({ subject, bodyText, fileNames, secureLinks: secure, to, customerAddresses: await customerAddresses(user, contactId, leadId) });
  const confirmed = formData.get("sensitiveOk") === "1";
  if (warning && !confirmed) {
    return { error: `${warning.text} Press Send again to see the warning and confirm.` };
  }

  // Secure links: store what was uploaded, make one link per file, and put the
  // links where the attachments would have been — in the message, above the signature.
  const sendingTenantId = secure ? await tenantIdFor(user.id) : null;
  let links: Awaited<ReturnType<typeof createSecureLinks>> = [];
  let messageHtml = bodyHtml;
  let linksText = "";
  let expiresLabel = "";
  if (secure) {
    if (!sendingTenantId) return { error: "No workspace attached to this sign-in — sign out and back in." };
    const expiresAt = secureLinkExpiry(new Date(), secureLinkDays(formData.get("secureDays")));
    expiresLabel = formatDate(expiresAt);
    try {
      for (const upload of secureUploads) {
        secureFiles.push({ fileName: upload.name, storedRef: await saveFile(upload.buffer, upload.name, upload.type, sendingTenantId), mimeType: upload.type, sizeBytes: upload.size });
      }
      links = await createSecureLinks({ tenantId: sendingTenantId, files: secureFiles, expiresAt, createdById: user.id, sentTo: to, contactId, leadId });
    } catch {
      return { error: "The files could not be stored for a secure link. Nothing was sent — try again, or send them as attachments." };
    }
    const origin = (await tenantOrigin(sendingTenantId)).replace(/\/$/, "");
    const lines = links.map((link) => ({ name: link.fileName, url: `${origin}/f/${link.token}`, sizeBytes: link.sizeBytes }));
    messageHtml = bodyHtml + secureLinksHtml(lines, expiresLabel);
    linksText = secureLinksText(lines, expiresLabel);
  }
  // The message (with its secure-link block, if any), the signature, and the signature banner for this sender and recipient.
  const { html, tenantId: bannerTenantId, bannerId } = await composerHtml(user, messageHtml, profile, { to, contactId, leadId, choice });

  const result = await sendEmail({
    to,
    subject,
    // The plain-text alternative every client falls back to, and the one place
    // the company was still named by a literal after the HTML signature stopped
    // doing it. It carried Denago's trading name and landline out of every
    // workspace. Built from the same profile the HTML signature uses, with empty
    // parts dropped rather than left as dangling separators.
    text: `${bodyText}${linksText}\n\n--\n${[user.name, profile.name, profile.phone].filter((s) => s && s.trim()).join(" · ")}`,
    html,
    attachments,
    replyTo: replyTo.value ?? undefined,
    // "Opened" on the timeline entry below (unless switched off in Settings → Email).
    trackOpens: true,
    // The person writing it: "Sean Tunley · Denago Cape Town" on the From line.
    senderName: user.name,
  });
  if (!result.ok) {
    // The email never left, so its links must not be left working.
    if (secure && sendingTenantId) await discardSecureLinks(sendingTenantId, links.map((link) => link.id)).catch(() => {});
    return { error: result.error };
  }

  /*
   * THE EMAIL HAS GONE. From here nothing may fail the action: an error returned
   * now tells the sender it did not send, and they send it again — to a customer
   * who already has it. So every piece of bookkeeping below stands ALONE: it is
   * tried, a failure is logged, and the next one is still attempted. One failed
   * write must not cost the others (the first version marked the quote sent only
   * after the timeline entry and the audit line had both succeeded, so a failed
   * audit write left a quote the customer was holding marked draft).
   */
  const bookkeeping = async <T,>(what: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (err) {
      const { logError } = await import("@/lib/errorLog");
      await logError("composer-after-send", `${what}: ${err instanceof Error ? err.name : "unknown"}`).catch(() => {});
      return undefined;
    }
  };

  // The quotes FIRST: what the quote says about itself is what staff act on next.
  const emailedAt = new Date();
  const nowSent: number[] = [];
  for (const quote of sentQuotes) {
    // A draft the customer now holds is a sent quote — the rule "Email quote" uses.
    const markedSent = (await bookkeeping(`mark Q-${quote.number} sent`, () => markQuoteSentIfDraft(quote))) === true;
    if (markedSent) nowSent.push(quote.number);
    // When it was emailed and to whom, on the quote — a draft, or one sent before and emailed again.
    await bookkeeping(`record Q-${quote.number} emailed`, () => recordQuoteEmailed(quote, to, emailedAt));
    await bookkeeping(`audit Q-${quote.number} emailed`, () =>
      logAudit({
        action: "quote.emailed",
        summary: `Emailed quote Q-${quote.number} to ${to} from the email composer${markedSent ? " — marked sent" : ""}`,
        leadId: quote.leadId,
        contactId: quote.contactId,
        user,
      }),
    );
    if (markedSent) await bookkeeping(`quote_sent trigger for Q-${quote.number}`, () => emitQuoteJourneyEvent("quote_sent", quote, `sent:${Date.now()}`));
  }

  if (bannerId && bannerTenantId) await bookkeeping("count the banner", () => recordBannerSent(bannerTenantId, bannerId));

  const filesNote = secure ? `Sent as secure links, until ${expiresLabel}` : "Attachments";
  const sent = await bookkeeping("file it on the timeline", async () =>
    prisma.communication.create({
      data: {
        type: "email",
        direction: "outbound",
        subject,
        body:
          attachedNames.length > 0
            ? `${bodyText}\n\n[${filesNote}: ${attachedNames.join(", ")}]`
            : bodyText,
        leadId,
        contactId,
        userId: user.id,
        tenantId: await customerRecordTenantId({ contactId, leadId }),
        ...(result.openToken ? { openToken: result.openToken } : {}),
        ...(result.bannerRef ? { bannerRef: result.bannerRef } : {}),
      },
      select: { id: true },
    }),
  );
  if (sent && secure && sendingTenantId) await attachSecureLinksToEmail(sendingTenantId, links.map((link) => link.id), sent.id).catch(() => {});
  await bookkeeping("audit the email", () => logAudit({
    action: "email.sent",
    // Where replies were directed is part of what was sent, and it is the one
    // detail nobody can recover afterwards — the message has left, and the header
    // exists only in the recipient's copy.
    // The subject and file names are what the sender typed, and may hold the very
    // number the check flagged. The email keeps them; this entry does not.
    summary: `Sent email to ${to}: “${redactSensitive(subject)}”${
      attachedNames.length > 0 ? ` (${secure ? `as secure links until ${expiresLabel}` : "attached"}: ${redactSensitive(attachedNames.join(", "))})` : ""
    }${replyTo.value ? ` (replies to: ${replyTo.value})` : ""}${
      // WHAT was flagged, never the number itself: an audit entry must not become a second copy of it.
      warning ? ` — sent after a sensitive-data warning (${warning.kinds.join(", ")})` : ""
    }`,
    contactId,
    leadId,
    user,
  }));
  if (sentQuotes.length > 0) revalidatePath("/quotes");
  revalidatePath(String(formData.get("revalidate") ?? "/"));
  const quoteNote = nowSent.length > 0 ? ` ${nowSent.map((n) => `Quote Q-${n}`).join(", ")} marked sent.` : "";
  // Sent, but not on the timeline: said plainly, with the one instruction that matters.
  const unfiled = sent ? "" : " It could not be added to the timeline — but it WAS sent. Do not send it again.";
  return { ok: `Email sent to ${to}.${quoteNote}${unfiled}` };
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
