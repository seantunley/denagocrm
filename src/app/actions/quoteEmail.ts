"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { getCurrentUser } from "@/lib/auth";
import { canAccessQuote, hasPermission } from "@/lib/permissions";
import { getSetting } from "@/lib/settings";
import { getCompanyProfile } from "@/lib/companyProfile";
import { htmlToPdf } from "@/lib/customDocs";
import { renderQuotePrintHtml } from "@/lib/quotePrintDocument";
import { sendEmail } from "@/lib/email";
import { buildEmailHtml, buildSignature, signatureCompanyFrom } from "@/lib/signature";
import { escapeHtml } from "@/lib/escapeHtml";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { composerReplyToDefault } from "@/lib/replyToDefault";
import { parseReplyTo } from "@/lib/replyToAddresses";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { logAudit } from "@/lib/audit";
import { formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import {
  QUOTE_EMAIL_TEMPLATE_SETTING,
  composeQuoteEmail,
  deliverQuoteEmail,
  quoteEmailVars,
  quotePdfFileName,
} from "@/lib/quoteEmail";

export type QuoteEmailDraft =
  | { ok: true; to: string; subject: string; body: string; fileName: string }
  | { ok: false; error: string };

export type QuoteEmailResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Emailing a quote is sending it to the customer, so it takes the permission
 * every other send of a quote takes — `quotes.change_status` on THIS quote, the
 * pair setQuoteStatus and the signing actions require (requireQuoteAccess).
 * Checked without redirect(), because these feed a dialog.
 */
async function emailingUser(quoteId: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!(await hasPermission(user, "quotes.change_status"))) return null;
  if (!(await canAccessQuote(user, quoteId))) return null;
  return user;
}

async function loadQuote(quoteId: string) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { items: true, fees: true, contact: true, lead: true },
  });
  if (!quote || quote.deletedAt) return null;
  return quote;
}

/** What the dialog shows before anything is sent. Sends nothing. */
export async function quoteEmailDraft(quoteId: string): Promise<QuoteEmailDraft> {
  return withActingStaffScope(async () => {
    const user = await emailingUser(quoteId);
    if (!user) return { ok: false, error: "Your role can't send quotes to customers." };
    const quote = await loadQuote(quoteId);
    if (!quote) return { ok: false, error: "This quote no longer exists." };

    const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
    const [templateId, company] = await Promise.all([getSetting(QUOTE_EMAIL_TEMPLATE_SETTING), getCompanyProfile()]);
    const template = templateId
      ? await prisma.emailTemplate.findUnique({ where: { id: templateId }, select: { subject: true, body: true } })
      : null;
    const vars = quoteEmailVars({
      // The person, not the fleet account: "Hi Acme Logistics" reads wrong.
      customerName: billTo.attention || billTo.name,
      quoteNumber: quote.number,
      total: formatZAR(Math.round(payableTotalCents(quote))),
      companyName: company.name,
      senderName: user.name,
    });
    return { ok: true, to: billTo.email, ...composeQuoteEmail(template, vars), fileName: quotePdfFileName(quote.number) };
  });
}

/**
 * The explicit Send. Renders the PDF from the Print / PDF renderer, emails it,
 * and only after a successful send marks a draft quote sent and logs it on the
 * customer's timeline. See deliverQuoteEmail for why the order is the point.
 */
export async function sendQuoteEmail(
  quoteId: string,
  input: { to: string; subject: string; body: string },
): Promise<QuoteEmailResult> {
  return withActingStaffScope(async () => {
    const user = await emailingUser(quoteId);
    if (!user) return { ok: false, error: "Your role can't send quotes to customers." };

    // The recipient list reaches a mail header: validated hard, same rules as Reply-To.
    const to = parseReplyTo(String(input.to ?? ""));
    if (!to.ok) return { ok: false, error: `Not a valid email address: ${to.invalid.join(", ")}` };
    if (!to.value) return { ok: false, error: "Enter the customer's email address." };
    const subject = String(input.subject ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!subject || /[\r\n]/.test(subject)) return { ok: false, error: "Enter a one-line subject." };
    if (!body) return { ok: false, error: "The message can't be empty." };

    const quote = await loadQuote(quoteId);
    if (!quote) return { ok: false, error: "This quote no longer exists." };
    if (quote.supersededAt) return { ok: false, error: "This version has been replaced by a revision — email the latest one." };
    if (quote.items.length === 0) return { ok: false, error: "Add at least one line before sending the quote." };

    const fileName = quotePdfFileName(quote.number);
    const profile = await getCompanyProfile();
    const signature = buildSignature(user, signatureCompanyFrom(profile, await tenantOrigin(quote.tenantId)));
    const replyTo = await composerReplyToDefault(user.email);

    const result = await deliverQuoteEmail(
      { to: to.value, subject, body, fileName },
      {
        // The same renderer the Print / PDF button serves, so the attachment is
        // exactly what Preview showed.
        renderPdf: async () => {
          const html = await renderQuotePrintHtml({ quoteId });
          if (!html) return null;
          try {
            return await htmlToPdf(html);
          } catch (err) {
            const { logError } = await import("@/lib/errorLog");
            await logError("quote-email-pdf", err);
            return null;
          }
        },
        send: (mail) =>
          sendEmail({
            to: mail.to,
            subject: mail.subject,
            text: `${mail.body}\n\n--\n${[user.name, profile.name, profile.phone].filter((s) => s && s.trim()).join(" · ")}`,
            html: buildEmailHtml(escapeHtml(mail.body).replace(/\n/g, "<br>"), signature),
            attachments: mail.attachments,
            replyTo: replyTo || undefined,
          }),
        // Only a draft moves, and only the version that was rendered: an edit
        // saved while the PDF was being made bumps updatedAt, and the quote then
        // stays a draft rather than freezing a price the customer never saw.
        markSentIfDraft: async () =>
          (
            await prisma.quote.updateMany({
              where: {
                id: quoteId,
                status: "draft",
                updatedAt: quote.updatedAt,
                deletedAt: null,
                signedAt: null,
                supersededAt: null,
              },
              data: { status: "sent" },
            })
          ).count === 1,
        // The timeline entry, in the Communication shape sendEmailAction writes.
        // TODO(#694): move to sendEmail's `record` option once that PR lands.
        record: async (mail) => {
          await prisma.communication.create({
            data: {
              type: "email",
              direction: "outbound",
              subject: mail.subject,
              body: `${mail.body}\n\n[Attachments: ${mail.fileName}]`,
              leadId: quote.leadId,
              contactId: quote.contactId,
              userId: user.id,
              tenantId: await customerRecordTenantId({ contactId: quote.contactId, leadId: quote.leadId }),
            },
          });
          await logAudit({
            action: "quote.emailed",
            summary: `Emailed quote Q-${quote.number} (${formatZAR(Math.round(payableTotalCents(quote)))}) to ${mail.to} as ${mail.fileName}${
              mail.markedSent ? " — marked sent" : ""
            }`,
            leadId: quote.leadId,
            contactId: quote.contactId,
            user,
          });
        },
      },
    );
    if (!result.ok) return result;

    revalidatePath("/quotes");
    if (quote.leadId) revalidatePath(`/leads/${quote.leadId}`);
    if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);
    const note =
      quote.status === "draft" && !result.markedSent
        ? " The quote was edited while sending, so it was left as a draft — check it."
        : result.markedSent
          ? " Quote marked sent."
          : "";
    return { ok: true, message: `Quote Q-${quote.number} emailed to ${to.value}.${note}` };
  });
}
