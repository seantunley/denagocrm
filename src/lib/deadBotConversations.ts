import "server-only";
import { prisma } from "./db";
import { deliveryFailureReason, PERMANENT_FAILURES } from "./messageDelivery";
import { contactName } from "./format";
import { parkedFailureHead, UNPARKED_FAILURE } from "./botOutbox";

export type DeadBotConversation = {
  channel: string;
  key: string;
  contact: { id: string; name: string } | null;
  failedAt: Date;
  reason: string;
  /** Only a temporary failure (network, rate limit, provider hiccup, credentials) is worth sending again. */
  retryable: boolean;
  /**
   * Set when the failure did not park the conversation (a staff reply, or a
   * message the provider reported failed later): retry works on this message
   * (retryFailedMessage), not the session.
   */
  failedMessageId: string | null;
  /** Who sent the failed message, for the label. */
  origin: "bot" | "staff";
};

/** How far back an unparked failure is still worth surfacing. */
const UNPARKED_FAILURE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

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
      failedMessageId: null,
      origin: "bot",
    });
  }

  // Failures that did NOT park the conversation (UNPARKED_FAILURE): a staff
  // reply — it handed the conversation to a person, which is never parked — and
  // any message the provider accepted and then reported failed asynchronously.
  // The list above cannot see either (re-reviews of #733). Read from the outbox:
  // the newest per conversation, while nothing has reached the customer since
  // the failure became known. It leaves when a later message gets through, or on
  // retry.
  const seen = new Set(out.map((dead) => `${dead.channel}:${dead.key}`));
  const unparked = await prisma.botFlowOutbox.findMany({
    where: { ...UNPARKED_FAILURE, updatedAt: { gte: new Date(Date.now() - UNPARKED_FAILURE_WINDOW_MS) } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit * 2,
    select: { id: true, channel: true, key: true, origin: true, updatedAt: true, failureCode: true, contactId: true },
  });
  for (const failure of unparked) {
    if (out.length >= limit) break;
    const conversation = `${failure.channel}:${failure.key}`;
    if (seen.has(conversation)) continue;
    seen.add(conversation);
    // Measured from when the failure was KNOWN (updatedAt), not when the message
    // was queued: an async report can arrive after later messages already went,
    // and those did not answer for the one that failed.
    const reachedSince = await prisma.botFlowOutbox.findFirst({
      where: { channel: failure.channel, key: failure.key, status: "sent", createdAt: { gt: failure.updatedAt } },
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
      // A bot message is only offered again while the bot still owns the thread —
      // the same rule the retry enforces under lock (requeueFailedMessage).
      retryable: !PERMANENT_FAILURES.has(failure.failureCode ?? "") && !(failure.origin === "bot" && (await humanOwns(failure.channel, failure.key))),
      failedMessageId: failure.id,
      origin: failure.origin === "staff" ? "staff" : "bot",
    });
  }
  return out;
}

/** Whether a person has taken this conversation over (the fence's own test: ownership "human"). */
async function humanOwns(channel: string, key: string): Promise<boolean> {
  const session = await prisma.botSession.findFirst({ where: { channel, key }, select: { ownership: true } });
  return session?.ownership === "human";
}
