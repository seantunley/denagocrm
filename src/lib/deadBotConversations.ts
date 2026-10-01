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
  /**
   * Set when the failure is a STAFF reply: the conversation is with a person, not
   * parked, so retry works on this message (retryFailedStaffReply), not the session.
   */
  staffReplyId: string | null;
};

/** How far back a failed staff reply is still worth surfacing. */
const STAFF_FAILURE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

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
      staffReplyId: null,
    });
  }

  // Failed STAFF replies. A staff reply hands the conversation to a person
  // (ownership "human"), so its failure never parks the session and the list
  // above cannot see it (re-review of #733). Read from the outbox instead: the
  // newest reply per conversation that the worker failed (never one the provider
  // accepted — those carry its message id), and only while nothing has reached
  // the customer since. It leaves when a later message gets through, or on retry.
  const seen = new Set(out.map((dead) => `${dead.channel}:${dead.key}`));
  const staffFailures = await prisma.botFlowOutbox.findMany({
    where: {
      origin: "staff",
      status: "dead",
      providerMessageId: null,
      NOT: { failureCode: "blocked_by_earlier_failure" },
      updatedAt: { gte: new Date(Date.now() - STAFF_FAILURE_WINDOW_MS) },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit * 2,
    select: { id: true, channel: true, key: true, createdAt: true, updatedAt: true, failureCode: true, contactId: true },
  });
  for (const failure of staffFailures) {
    if (out.length >= limit) break;
    const conversation = `${failure.channel}:${failure.key}`;
    if (seen.has(conversation)) continue;
    seen.add(conversation);
    const reachedSince = await prisma.botFlowOutbox.findFirst({
      where: { channel: failure.channel, key: failure.key, status: "sent", createdAt: { gt: failure.createdAt } },
      select: { id: true },
    });
    if (reachedSince) continue;
    const contact = failure.contactId
      ? await prisma.contact.findFirst({
          where: { id: failure.contactId },
          select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
        })
      : null;
    out.push({
      channel: failure.channel,
      key: failure.key,
      contact: contact ? { id: contact.id, name: contactName(contact) } : null,
      failedAt: failure.updatedAt,
      reason: deliveryFailureReason(failure.failureCode) ?? "the channel rejected it",
      retryable: !PERMANENT_FAILURES.has(failure.failureCode ?? ""),
      staffReplyId: failure.id,
    });
  }
  return out;
}
