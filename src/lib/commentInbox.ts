import "server-only";
import { prisma } from "./db";
import { activeTenantPredicate } from "./tenantPredicate";
import {
  commentPlatform,
  commentPlatformPresentation,
  commentPostUrl,
  type CommentPlatform,
} from "./socialComments";

/**
 * Reading the comments screen.
 *
 * ── WHY THIS DOES NOT GO THROUGH inboxQuery.ts ──────────────────────────────
 *
 * That module threads by PERSON: it groups Communication rows by contact or
 * lead, and its window function partitions on exactly that. It also carries
 * careful reasoning about one talkative conversation starving fifty others,
 * which is worth leaving alone.
 *
 * A comment thread has no person. `buildInboxThreads` skips any row without a
 * contact or lead — correctly, since it has nothing to name the thread after —
 * so comments are invisible to it by construction rather than by oversight.
 *
 * Comments are a separate screen, so they get a separate read. Comment rows
 * carry `conversationId` and no contact, so the two queries cannot see each
 * other's threads even by accident.
 */

export type CommentThread = {
  conversationId: string;
  /** "facebook:<postId>" — the post this thread belongs to. */
  externalRef: string | null;
  platform: CommentPlatform | null;
  platformLabel: string;
  platformIcon: string | null;
  /** A link back to the post, when the platform has an addressable URL. */
  postUrl: string | null;
  subject: string;
  unread: boolean;
  muted: boolean;
  archived: boolean;
  lastAt: Date;
  messageCount: number;
  comments: {
    id: string;
    /** Meta's comment id — what a reply is addressed to. */
    commentId: string | null;
    direction: string | null;
    author: string | null;
    body: string;
    at: Date;
    attachmentUrl: string | null;
    /**
     * Someone has already sent the one private reply Meta allows for this
     * comment. Read from the replies themselves rather than assumed, so the
     * screen stops offering an action that would be refused — including to a
     * second person looking at the same post.
     */
    privateReplied: boolean;
  }[];
};

/** How many comments of each thread to render before "open the post". */
const COMMENTS_PER_THREAD = 12;

export async function loadCommentThreads(
  options: { archived?: boolean; limit?: number } = {},
): Promise<CommentThread[]> {
  const archived = options.archived ?? false;
  const threads = await prisma.conversation.findMany({
    where: {
      channel: "comment",
      // Archived means "dealt with" — status is what the rest of the inbox
      // already uses for it, so no new column was needed.
      status: archived ? "closed" : { not: "closed" },
      ...activeTenantPredicate("comments screen"),
    },
    orderBy: { lastMessageAt: "desc" },
    take: options.limit ?? 40,
    select: {
      id: true,
      externalRef: true,
      subject: true,
      unread: true,
      mutedAt: true,
      status: true,
      lastMessageAt: true,
      messageCount: true,
      messages: {
        orderBy: { occurredAt: "desc" },
        // Bounded PER THREAD by being nested inside the thread select, so one
        // post with three thousand comments cannot starve the others — the same
        // property inboxQuery.ts reaches for with a window function, had for
        // free here because these threads are rows rather than groupings.
        take: COMMENTS_PER_THREAD,
        select: {
          id: true,
          messageId: true,
          direction: true,
          subject: true,
          body: true,
          occurredAt: true,
          attachmentUrl: true,
        },
      },
    },
  });

  /*
   * WHICH COMMENTS HAVE ALREADY HAD THEIR ONE PRIVATE REPLY.
   *
   * Its own query, and not read from the messages above, because those are
   * capped at the newest few per thread — a reply sent last week to a comment
   * further up would fall outside that window, and the button would come back
   * offering an action Meta refuses. `inReplyTo` holds the comment each reply
   * answers.
   */
  const repliedTo = new Set(
    (
      await prisma.communication.findMany({
        where: {
          conversationId: { in: threads.map((thread) => thread.id) },
          type: "comment",
          direction: "outbound",
          subject: "Private reply",
          inReplyTo: { not: null },
        },
        select: { inReplyTo: true },
      })
    ).map((row) => row.inReplyTo as string),
  );

  return threads.map((thread) => {
    const platform = commentPlatform(thread.externalRef);
    const presentation = commentPlatformPresentation(platform);
    return {
      conversationId: thread.id,
      externalRef: thread.externalRef,
      platform,
      platformLabel: presentation.label,
      platformIcon: presentation.icon,
      postUrl: commentPostUrl(thread.externalRef),
      subject: thread.subject ?? "Comment thread",
      unread: thread.unread,
      muted: thread.mutedAt !== null,
      archived: thread.status === "closed",
      lastAt: thread.lastMessageAt,
      messageCount: thread.messageCount,
      comments: thread.messages
        .map((message) => ({
          id: message.id,
          commentId: message.messageId,
          direction: message.direction,
          // The commenter's name is stored in `subject` — a comment thread has
          // no contact to read it from, and the name the platform sends is all
          // we have.
          author: message.subject,
          body: message.body,
          at: message.occurredAt,
          attachmentUrl: message.attachmentUrl,
          privateReplied: message.messageId !== null && repliedTo.has(message.messageId),
        }))
        // Newest-first out of the database so `take` keeps the RECENT ones;
        // oldest-first for reading, which is how a conversation is read.
        .reverse(),
    };
  });
}
