import "server-only";
import { prisma } from "./db";
import { deliveryFailureReason, PERMANENT_FAILURES } from "./messageDelivery";
import { contactName } from "./format";
import { parkedFailureHead } from "./botOutbox";

export type DeadBotConversation = {
  channel: string;
  key: string;
  contact: { id: string; name: string } | null;
  failedAt: Date;
  reason: string;
  /** Only a temporary failure (network, rate limit, provider hiccup, credentials) is worth sending again. */
  retryable: boolean;
};

/**
 * Conversations where the bot's last message definitively failed (gap audit #31).
 *
 * The outbox already dead-letters the message and parks the conversation at
 * `delivery_failed`, so the bot stops. But the customer is left waiting at a
 * prompt they never received, and nothing showed staff that it had happened —
 * only the error log. The parked session IS the list: it leaves on its own when
 * a person replies (ownership → human), the customer writes again (the bot
 * restarts), or someone retries the send.
 *
 * Guarded client throughout, so every read is the viewer's workspace.
 */
export async function listDeadBotConversations(limit = 25): Promise<DeadBotConversation[]> {
  const sessions = await prisma.botSession.findMany({
    where: { ownership: "delivery_failed" },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, tenantId: true, channel: true, key: true, updatedAt: true },
  });
  const out: DeadBotConversation[] = [];
  for (const session of sessions) {
    // The message that actually failed — not the backlog it took down with it,
    // and the same one "Send again" retries, so the reason and the button agree.
    const head = await parkedFailureHead(prisma, {
      tenantId: session.tenantId ?? undefined,
      channel: session.channel,
      key: session.key,
      sessionId: session.id,
    });
    const contact = head?.contactId
      ? await prisma.contact.findFirst({
          where: { id: head.contactId },
          select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
        })
      : null;
    out.push({
      channel: session.channel,
      key: session.key,
      contact: contact ? { id: contact.id, name: contactName(contact) } : null,
      failedAt: head?.updatedAt ?? session.updatedAt,
      reason: deliveryFailureReason(head?.failureCode ?? null) ?? "the channel rejected it",
      retryable: !PERMANENT_FAILURES.has(head?.failureCode ?? ""),
    });
  }
  return out;
}
