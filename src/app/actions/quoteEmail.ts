"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { getCurrentUser } from "@/lib/auth";
import { canAccessQuote, hasPermission, type PermissionUser } from "@/lib/permissions";
import { htmlToPdf } from "@/lib/customDocs";
import { renderQuotePrintHtml } from "@/lib/quotePrintDocument";
import { sendEmail } from "@/lib/email";
import { composerReplyToDefault } from "@/lib/replyToDefault";
import { parseReplyTo } from "@/lib/replyToAddresses";
import { logAudit } from "@/lib/audit";
import { formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { validateSigningTemplate } from "@/lib/signing/emailTemplates";
import { tenantEmailContent } from "@/lib/signing/signingEmail";
import { deliverQuoteEmail, quotePdfFileName } from "@/lib/quoteEmail";

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

type LoadedQuote = NonNullable<Awaited<ReturnType<typeof loadQuote>>>;

/** The quote's merge fields. Company fields are filled from the QUOTE's tenant by tenantEmailContent. */
async function quoteVars(quote: LoadedQuote, user: PermissionUser) {
  const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
  // The person, not the fleet account: "Hi Acme Logistics" reads wrong.
  const name = (billTo.attention || billTo.name).trim();
  return {
    to: billTo.email,
    vars: {
      recipient_name: name,
      first_name: name.split(/\s+/)[0] ?? "",
      document_title: `Quote Q-${quote.number}`,
      quote_number: `Q-${quote.number}`,
      total: formatZAR(Math.round(payableTotalCents(quote))),
      sender_name: user.name,
    },
  };
}

/** What the dialog shows before anything is sent: the tenant's saved Quote email, merged. Sends nothing. */
export async function quoteEmailDraft(quoteId: string): Promise<QuoteEmailDraft> {
  return withActingStaffScope(async () => {
    const user = await emailingUser(quoteId);
    if (!user) return { ok: false, error: "Your role can't send quotes to customers." };
    const quote = await loadQuote(quoteId);
    if (!quote) return { ok: false, error: "This quote no longer exists." };
    const { to, vars } = await quoteVars(quote, user);
    const email = await tenantEmailContent("quote", quote.tenantId, vars);
    return { ok: true, to, subject: email.subject, body: email.text, fileName: quotePdfFileName(quote.number) };
  });
}

/**
 * The explicit Send. Renders the PDF from the Print / PDF renderer, emails it in
 * the tenant's branded layout, and only after a successful send marks a draft
 * quote sent and audits it. See deliverQuoteEmail for why the order is the point.
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
    // The per-send edit goes through the SAME validation as the saved template.
    const subject = String(input.subject ?? "").trim();
    const body = String(input.body ?? "").replace(/\r\n?/g, "\n").trim();
    const problem = validateSigningTemplate("quote", subject, body);
    if (problem) return { ok: false, error: problem };

    const quote = await loadQuote(quoteId);
    if (!quote) return { ok: false, error: "This quote no longer exists." };
    if (quote.supersededAt) return { ok: false, error: "This version has been replaced by a revision — email the latest one." };
    if (quote.items.length === 0) return { ok: false, error: "Add at least one line before sending the quote." };

    const fileName = quotePdfFileName(quote.number);
    const { vars } = await quoteVars(quote, user);
    // Rendered escaped into the branded shell; CR/LF cannot reach the subject.
    const email = await tenantEmailContent("quote", quote.tenantId, vars, { subject, body });
    const replyTo = await composerReplyToDefault(user.email);

    const result = await deliverQuoteEmail(
      { to: to.value, fileName },
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
        // `record`: the shared timeline entry, written once SMTP accepts the mail.
        send: (mail) =>
          sendEmail({
            to: mail.to,
            subject: email.subject,
            text: email.text,
            html: email.html,
            attachments: mail.attachments,
            replyTo: replyTo || undefined,
            record: { contactId: quote.contactId, leadId: quote.leadId, userId: user.id, label: "Quote email" },
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
        audit: async (sent) => {
          await logAudit({
            action: "quote.emailed",
            summary: `Emailed quote Q-${quote.number} (${vars.total}) to ${sent.to} as ${sent.fileName}${
              sent.markedSent ? " — marked sent" : ""
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
