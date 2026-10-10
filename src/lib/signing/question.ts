import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { sendPushToAll } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { isReplyToAddress } from "@/lib/replyToAddresses";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { resolveTenantActor, resolveTenantMemberUser } from "@/lib/tenantActor";

/**
 * A signer's question, put in front of the people who can answer it.
 *
 * Until now a customer who was unsure about one line could sign anyway or decline
 * the whole document; there was no third answer. This is where the third answer
 * goes once it has been asked.
 *
 * It is NOT an Inbox thread. The Inbox lists WhatsApp, Messenger, Instagram, X
 * and Telegram conversations and replies on the channel a thread arrived by; a
 * question typed on a web page has no channel to reply on. So it goes where
 * staff answer everything else about a customer:
 *
 *   the timeline  an inbound entry on the customer and the deal. Not a "note" —
 *                 a note is something WE wrote (customerContact.ts) — so the deal
 *                 reads as waiting on our reply until somebody gets in touch.
 *   a push        to the workspace, under "Quote questions / changes", which is
 *                 switchable in Settings → Notifications.
 *   an email      to whoever sent the document, with the customer as Reply-To:
 *                 answering it is pressing Reply.
 *
 * Nothing here contacts the customer.
 */

/** How the entry is labelled on a timeline: "Question · inbound". */
export const QUESTION_COMMUNICATION_TYPE = "question";

export type SignerQuestion = {
  request: { id: string; title: string; tenantId: string | null; contactId: string | null; quoteId: string | null; jobCardId: string | null; createdById: string | null };
  signer: { name: string; email: string | null };
  question: string;
};

/** Who the question is about: the request's own contact, or its record's. */
async function subjectOf(request: SignerQuestion["request"]): Promise<{ contactId: string | null; leadId: string | null }> {
  if (request.quoteId) {
    const quote = await prisma.quote.findUnique({ where: { id: request.quoteId }, select: { contactId: true, leadId: true } });
    return { contactId: request.contactId ?? quote?.contactId ?? null, leadId: quote?.leadId ?? null };
  }
  if (request.jobCardId && !request.contactId) {
    const jobCard = await prisma.jobCard.findUnique({ where: { id: request.jobCardId }, select: { contactId: true } });
    return { contactId: jobCard?.contactId ?? null, leadId: null };
  }
  return { contactId: request.contactId, leadId: null };
}

/**
 * Files the question and alerts the sender. Returns false only when it reached
 * NOBODY — neither a timeline nor the sender's mailbox — so the page can tell the
 * signer to get in touch another way instead of saying "sent".
 */
export async function deliverSignerQuestion({ request, signer, question }: SignerQuestion): Promise<boolean> {
  const subject = await subjectOf(request).catch(() => ({ contactId: request.contactId, leadId: null }));
  // The member of staff the entry is filed against (the column is required): the
  // sender while they are still on the team, otherwise anyone who is.
  const sender = request.createdById ? await resolveTenantMemberUser(request.createdById).catch(() => null) : null;
  const filer = sender ?? (await resolveTenantActor().catch(() => null));
  const about = `Question about ${request.title}`;

  const onTimeline = async (): Promise<boolean> => {
    if (!filer || (!subject.contactId && !subject.leadId)) return false;
    await prisma.communication.create({
      data: {
        type: QUESTION_COMMUNICATION_TYPE,
        direction: "inbound",
        subject: about,
        body: `${question}\n\n— ${signer.name}, from the signing page`,
        contactId: subject.contactId,
        leadId: subject.leadId,
        userId: filer.id,
        tenantId: await customerRecordTenantId({ contactId: subject.contactId, leadId: subject.leadId }),
      },
    });
    return true;
  };

  const where = subject.leadId ? `/leads/${subject.leadId}` : subject.contactId ? `/contacts/${subject.contactId}` : `/signatures/${request.id}`;

  const byEmail = async (): Promise<boolean> => {
    if (!sender?.email) return false;
    const link = `${(await tenantOrigin(request.tenantId)) || ""}${where}`;
    // A header value, so it is checked as one — whatever is on the recipient row.
    const replyTo = signer.email && isReplyToAddress(signer.email.trim()) ? signer.email.trim() : null;
    const sent = await sendEmail({
      to: sender.email,
      subject: `${signer.name} has a question about ${request.title}`,
      text:
        `${signer.name} asked this on the signing page for "${request.title}":\n\n${question}\n\n` +
        (replyTo
          ? `Reply to this email to answer ${signer.name} directly.`
          : `There is no email address on file for ${signer.name} — call or message them.`) +
        `\n\nThey have not signed or declined; their link is still open.\n${link}`,
      ...(replyTo ? { replyTo } : {}),
    });
    return sent.ok;
  };

  const [timeline, email] = await Promise.all([
    onTimeline().catch(async (error) => { await logError("signing", error, "Could not file a signer's question on the timeline"); return false; }),
    byEmail().catch(async (error) => { await logError("signing", error, "Could not email a signer's question to the sender"); return false; }),
  ]);

  await sendPushToAll(
    { title: `${signer.name} has a question`, body: `About “${request.title}”: ${question}`.slice(0, 200), url: where },
    "quote_feedback",
    { tenantId: request.tenantId },
  ).catch(() => 0);
  await logAudit({
    action: "signing.question",
    summary: `${signer.name} asked a question about “${request.title}” on the signing page`,
    contactId: subject.contactId,
    leadId: subject.leadId,
    userName: signer.name,
    entityType: "SignatureRequest",
    entityId: request.id,
  }).catch(() => {});

  return timeline || email;
}
