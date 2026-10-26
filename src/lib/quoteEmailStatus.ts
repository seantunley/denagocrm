import "server-only";
import { prisma } from "./db";
import { emailSendStatus } from "./emailOpenTracking";

/**
 * WHAT HAPPENED TO THE EMAIL THAT CARRIED A QUOTE — so "Q-1040 was sent" is never said of a quote whose email
 * bounced (DAX roadmap, Phase 2). The quote's own status, or its signing request, says "sent" the moment our
 * mail server takes it; a refusal from the customer's server arrives later, on the email's timeline entry
 * (lib/emailBounce.ts), and nothing on the quote changes.
 *
 * The latest outbound email on the quote's customer or deal, since the quote was made, that names it: the quote
 * email's subject ("Your quote Q-1040 …") or its attachment line ("Q-1040 <company>.pdf"), or a signing
 * invitation's "Quote Q-1040". Read on the tenant-scoped client (RLS applies); only the wording leaves here,
 * never the email's text or address.
 *
 * ponytail: matched by the number in the email's text — a workspace that edits the quote number out of both its
 * subject and its body isn't seen. A quoteId on Communication is the upgrade if that happens.
 */
export type QuoteSend = { status: string; bounced: boolean };

export async function quoteSends(
  quotes: { id: string; number: number; contactId: string | null; leadId: string | null; createdAt: Date }[],
): Promise<Map<string, QuoteSend>> {
  const found = new Map<string, QuoteSend>();
  const contactIds = [...new Set(quotes.flatMap((q) => (q.contactId ? [q.contactId] : [])))];
  const leadIds = [...new Set(quotes.flatMap((q) => (q.leadId ? [q.leadId] : [])))];
  if (!contactIds.length && !leadIds.length) return found;
  const emails = await prisma.communication.findMany({
    where: {
      type: "email",
      direction: "outbound",
      occurredAt: { gte: new Date(Math.min(...quotes.map((q) => q.createdAt.getTime()))) },
      AND: [
        { OR: [...(contactIds.length ? [{ contactId: { in: contactIds } }] : []), ...(leadIds.length ? [{ leadId: { in: leadIds } }] : [])] },
        { OR: quotes.flatMap((q) => [{ subject: { contains: `Q-${q.number}` } }, { body: { contains: `Q-${q.number}` } }]) },
      ],
    },
    orderBy: { occurredAt: "desc" },
    take: 200,
    select: { contactId: true, leadId: true, subject: true, body: true, occurredAt: true, openToken: true, messageId: true, seenAt: true, bouncedAt: true, bounceReason: true },
  });
  for (const q of quotes) {
    // "Q-104" must not match an email about Q-1040.
    const names = new RegExp(`\\bQ-${q.number}(?!\\d)`);
    const email = emails.find((e) =>
      ((q.contactId && e.contactId === q.contactId) || (q.leadId && e.leadId === q.leadId)) &&
      e.occurredAt >= q.createdAt &&
      (names.test(e.subject ?? "") || names.test(e.body)));
    if (email) found.set(q.id, { status: emailSendStatus(email), bounced: email.bouncedAt !== null });
  }
  return found;
}
