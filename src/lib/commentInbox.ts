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
        }))
        // Newest-first out of the database so `take` keeps the RECENT ones;
        // oldest-first for reading, which is how a conversation is read.
        .reverse(),
    };
  });
}
