import "server-only";

/**
 * SENDING A COMPOSER EMAIL — every check and every consequence, for whoever is
 * sending: the person pressing Send (sendEmailAction), or the scheduled-emails
 * cron sending, at its time, an email that person scheduled (lib/emailDrafts.ts).
 *
 * Moved here from actions/emails.ts unchanged in substance when scheduling was
 * added (Sean, 2026-10-15). It takes the person as an argument, which is exactly
 * why it cannot live in a "use server" file: every export there can be called
 * from a browser, with any argument. The form's fields stay the interchange —
 * the cron rebuilds the same FormData from a stored draft — so a scheduled email
 * goes through the same lines of code, and the same refusals, as one sent now.
 */
import { formatDate } from "@/lib/format";
import { picturesIn, redactSensitive, sendWarning, type SendWarning } from "@/lib/sendCheck";
import { secureLinkDays, secureLinkExpiry, secureLinksHtml, secureLinksText } from "@/lib/secureLinks";
import { attachSecureLinksToEmail, createSecureLinks, discardSecureLinks, type SecureFile } from "@/lib/secureLinkStore";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { dealTimelineWhere, postedDealId } from "@/lib/customerTimeline";
import { resolveFiling } from "@/lib/customerTimelineFiling";
import { getSetting } from "@/lib/settings";
import { canAccessContact, canAccessLead, canAccessQuote, hasAnyPermission, hasPermission, type PermissionUser } from "@/lib/permissions";
import { quotePdfFileName } from "@/lib/quoteEmail";
import { markQuoteSentIfDraft, quotePdf, recordQuoteEmailed } from "@/lib/quoteEmailSend";
import { COMPOSER_QUOTE_STATUSES } from "@/lib/composerQuotes";
import { emitQuoteJourneyEvent } from "@/lib/leadJourneyEvents";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { signatureCompanyFrom, buildSignature, buildEmailHtml, htmlToText, parseSignatureDesign, SIGNATURE_DESIGN_KEY } from "@/lib/signature";
import { getCompanyProfile } from "@/lib/companyProfile";
import { isPublicBlobRef, readFile, saveFile, storesPrivately } from "@/lib/storage";
import { emailUploads } from "@/lib/emailUploads";
import { resolveActingTenant } from "@/lib/tenantContext";
import { parseAddressList, parseReplyTo } from "@/lib/replyToAddresses";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { bannerClickUrl, bannerHtml, bannerPosition } from "@/lib/signatureBanners";
import { LEGAL_LINE_KEY, htmlWithLegalLine } from "@/lib/emailLegalLine";
import { bannerForEmail, recordBannerSent } from "@/lib/signatureBannerStore";
import { threadableMessageId } from "@/lib/emailReply";

/** Each attached quote is a PDF rendered during the send; a handful is plenty for one email. */
const MAX_QUOTES_PER_EMAIL = 5;
/** The most addresses in each of To, Cc and Bcc. A customer email, not a mailing — that is what campaigns are for. */
const MAX_RECIPIENTS = 10;

/**
 * A secure link promises to expire and to be recallable. A file in the public
 * Blob store has a URL of its own that neither promise reaches, so a secure
 * link is only made where files are stored privately. Said before anything is
 * stored or sent.
 */
export const NO_PRIVATE_STORE =
  "Secure links need the private file store, which is not switched on for this CRM. Nothing was sent — untick “Send as a secure link” to attach the files instead.";

export type ComposerSendResult = { ok?: string; error?: string; communicationId?: string };

export async function tenantIdFor(userId: string): Promise<string | null> {
  const tenant = await resolveActingTenant(userId);
  return "tenantId" in tenant ? tenant.tenantId : null;
}

/** `choice`: the banner the sender picked in the composer — an id, "none", or blank for the default. */
export type ComposerRecipient = { to?: string; contactId?: string | null; leadId?: string | null; choice?: string | null };

/**
 * The composer email's HTML: the message, the sender's signature, and under it
 * the signature banner that is live for this sender (Settings → Signature
 * banners) — unless the recipient opted out of marketing. One builder, so
 * Preview is what Send sends; only the banner's LINK differs (`preview`), so
 * that trying it in the preview is not counted as a customer's click.
 */
export async function composerHtml(
  user: PermissionUser,
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

/** The addresses already on the customer record this email is filed on — only for records the caller may open. */
export async function customerAddresses(user: PermissionUser, contactId: string | null, leadId: string | null): Promise<string[]> {
  const [contact, lead] = await Promise.all([
    contactId && (await canAccessContact(user, contactId)) ? prisma.contact.findUnique({ where: { id: contactId }, select: { email: true } }) : null,
    leadId && (await canAccessLead(user, leadId)) ? prisma.lead.findUnique({ where: { id: leadId }, select: { email: true, contact: { select: { email: true } } } }) : null,
  ]);
  return [contact?.email, lead?.email, lead?.contact?.email].filter((address): address is string => Boolean(address?.trim()));
}

/**
 * Send the email the form describes, as `user`, and file it on the timeline.
 *
 * `check`: run every check and refusal Send makes, then stop — nothing stored,
 * rendered or sent. Scheduling uses it so an email that could never go is
 * refused when it is scheduled, not discovered at 08:00 the next morning.
 */
export async function sendComposerForm(
  user: PermissionUser,
  formData: FormData,
  options: { check?: boolean } = {},
): Promise<ComposerSendResult & { warning?: SendWarning | null; filing?: { contactId: string | null; leadId: string | null } }> {
  // TO, CC AND BCC: address lists, as in Outlook (Sean, 2026-10-15). Each reaches a
  // mail header, so each is held to the rule Reply-to is — every part a plain
  // address, refused rather than trimmed — and To, which used to go to the mail
  // server as typed with no check here at all, now is too.
  const lists = {
    To: parseAddressList(String(formData.get("to") ?? ""), MAX_RECIPIENTS),
    Cc: parseAddressList(String(formData.get("cc") ?? ""), MAX_RECIPIENTS),
    Bcc: parseAddressList(String(formData.get("bcc") ?? ""), MAX_RECIPIENTS),
  };
  for (const [field, list] of Object.entries(lists)) {
    if (!list.ok) return { error: `${field} is not a valid address list: ${list.invalid.join(", ")}` };
  }
  const to = lists.To.ok ? lists.To.value ?? "" : "";
  const cc = lists.Cc.ok ? lists.Cc.value ?? "" : "";
  const bcc = lists.Bcc.ok ? lists.Bcc.value ?? "" : "";
  /** Everyone it goes to — what the check before sending asks about. */
  const everyone = [to, cc, bcc].filter(Boolean).join(", ");
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
  // A REPLY to an email on the timeline (Reply / Reply all): threaded to it in their mailbox, when the CRM knows
  // the Message-ID it went or came with. The id is posted by the browser, so it must be an email filed on THIS
  // timeline the reply is written from — the caller's access to the customer says nothing about a row named by id.
  // From a DEAL's page (it posts the deal alone): that deal's timeline, exactly as the page shows it. From the
  // CUSTOMER's page: the customer's timeline, where an email on a deal counts only if the caller may open that deal —
  // the same rules that decide whether each page shows it at all (lib/customerTimeline).
  const inReplyToId = String(formData.get("inReplyTo") ?? "").trim().slice(0, 64);
  const found = inReplyToId
    ? await prisma.communication.findFirst({
        where: {
          id: inReplyToId,
          type: "email",
          ...(!postedContactId && leadId ? dealTimelineWhere({ id: leadId, contactId }) : contactId ? { OR: [{ contactId }, { lead: { contactId } }] } : { id: "" }),
        },
        select: { messageId: true, references: true, leadId: true },
      })
    : null;
  const answering = found && (!found.leadId || (await canAccessLead(user, found.leadId))) ? found : null;
  if (inReplyToId && !answering) return { error: "The email you are replying to is not on this customer's timeline. Nothing was sent." };
  const parentId = threadableMessageId(answering?.messageId);
  const references = parentId
    ? [...String(answering?.references ?? "").split(/\s+/).filter((id) => threadableMessageId(id)), parentId].slice(-20).join(" ")
    : "";
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
    // A library file chosen when it was scheduled and deleted since: said, not sent without it.
    if (versions.length !== new Set(attachIds).size) return { error: "A document chosen from the library is no longer there. Nothing was sent." };
    for (const v of versions) {
      fileNames.push(v.fileName);
      attachedNames.push(`${v.document.name} (v${v.version})`);
      if (options.check) continue;
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
    fileNames.push(file.name);
    attachedNames.push(file.name);
    if (options.check) continue;
    const buffer = Buffer.from(await file.arrayBuffer());
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
    const name = quotePdfFileName(quote.number, profile.name);
    fileNames.push(name);
    attachedNames.push(name);
    // Checking only: the PDF is made when the email actually goes, from the quote as it is then.
    if (options.check) continue;
    const pdf = await quotePdf(quote.id);
    if (!pdf) return { error: `The PDF for quote Q-${quote.number} could not be generated. Nothing was sent.` };
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
  // Asked of EVERYONE it goes to: an ID number copied to a stranger is no safer for being in Cc.
  const warning = sendWarning({ subject, bodyText, fileNames, secureLinks: secure, to: everyone, customerAddresses: await customerAddresses(user, contactId, leadId), pictures: picturesIn(bodyHtml) });
  const confirmed = formData.get("sensitiveOk") === "1";
  if (warning && !confirmed) {
    return { error: `${warning.text} Press Send again to see the warning and confirm.` };
  }
  if (options.check) return { warning, filing: { contactId, leadId } };

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
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    replyTo: replyTo.value ?? undefined,
    ...(parentId ? { headers: { "In-Reply-To": parentId, References: references } } : {}),
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
        // Who else it went to is part of what was sent, and is otherwise only in the recipients' copies.
        body:
          (attachedNames.length > 0
            ? `${bodyText}\n\n[${filesNote}: ${attachedNames.join(", ")}]`
            : bodyText) + (cc ? `\n[Cc: ${cc}]` : "") + (bcc ? `\n[Bcc: ${bcc}]` : ""),
        // …and kept apart from the words, which a customer's own email can make say anything: Reply all reads this.
        ...(cc ? { cc } : {}),
        leadId,
        contactId,
        userId: user.id,
        tenantId: await customerRecordTenantId({ contactId, leadId }),
        ...(result.openToken ? { openToken: result.openToken } : {}),
        ...(result.bannerRef ? { bannerRef: result.bannerRef } : {}),
        // Kept so a reply to THIS email threads too, and the customer's answer can be matched to it.
        ...(threadableMessageId(result.messageId) ? { messageId: result.messageId } : {}),
        ...(parentId ? { inReplyTo: parentId, references } : {}),
      },
      select: { id: true },
    }),
  );
  if (sent && secure && sendingTenantId) await attachSecureLinksToEmail(sendingTenantId, links.map((link) => link.id), sent.id).catch(() => {});
  const scheduled = formData.get("scheduledSend") === "1";
  await bookkeeping("audit the email", () => logAudit({
    action: "email.sent",
    // Where replies were directed is part of what was sent, and it is the one
    // detail nobody can recover afterwards — the message has left, and the header
    // exists only in the recipient's copy.
    // The subject and file names are what the sender typed, and may hold the very
    // number the check flagged. The email keeps them; this entry does not.
    summary: `${scheduled ? "Sent scheduled email" : "Sent email"} to ${to}${cc ? ` (cc ${cc})` : ""}${bcc ? ` (bcc ${bcc})` : ""}: “${redactSensitive(subject)}”${
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
  return { ok: `Email sent to ${to}.${quoteNote}${unfiled}`, communicationId: sent?.id };
}
