import "server-only";
import { prisma, basePrisma } from "./db";
import { logError } from "./errorLog";
import { resolveTenantActor } from "./tenantActor";
import { writeTenantId } from "./tenantWrite";
import { DEFAULT_TENANT_ID } from "./tenant";
import { isDedupeKeyConflict } from "./inboundMessageKey";
import {
  commentDedupeKey,
  commentThreadRef,
  commentThreadSubject,
  isOwnPageComment,
  type IngestibleComment,
} from "./socialComments";

/**
 * Filing a post's comments as their own inbox thread.
 *
 * ── WHY COMMENTS ARE NOT DMs ────────────────────────────────────────────────
 *
 * A DM thread is one customer, and `findOpenConversation` finds it by that
 * person. A comment thread is one POST: many people, arriving in public, most of
 * whom the CRM has never met — because a commenter's Facebook id is NOT their
 * Messenger id and cannot be matched to an existing contact or DM thread.
 *
 * So these threads are keyed by `Conversation.externalRef` instead of by a
 * person, live on their own `comment` channel so they never mix into the DM
 * mailbox, and attach to no contact at all. Attaching one on a guess would put
 * a stranger's public comment onto a real customer's timeline.
 */

export type CommentIngestOutcome =
  | { status: "filed"; conversationId: string; direction: "inbound" | "outbound" }
  | { status: "duplicate" }
  | { status: "muted" }
  | { status: "no-actor" };

/**
 * Find (or open) the thread for one post, and file the comment into it.
 *
 * Never throws for an ordinary condition. A webhook that failed on a muted post
 * or a redelivery would be retried by Meta forever, which turns a non-event into
 * an outage.
 */
export async function recordPostComment(
  comment: IngestibleComment,
  options: { platform: "facebook" | "instagram"; pageId: string | null },
): Promise<CommentIngestOutcome> {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const ref = commentThreadRef(options.platform, comment.postId);

  const thread = await findOrOpenThread(tenantId, ref, comment);

  // Muted: the post is known and deliberately silenced. Acknowledge and drop.
  // Checked AFTER the thread is resolved rather than before, because the mute
  // lives on the thread — there is nowhere else to record the decision.
  if (thread.mutedAt) return { status: "muted" };

  // Every Communication needs an owning user. A webhook has no session, so this
  // is the same tenant-aware actor every other inbound channel resolves.
  const actor = await resolveTenantActor();
  if (!actor) return { status: "no-actor" };

  // The Page's own comment is OUTBOUND, not noise. Somebody replying in
  // Facebook itself is answering the customer, and a thread showing only one
  // side would invite a second person to answer again.
  const direction = isOwnPageComment(comment, options.pageId) ? "outbound" : "inbound";
  const dedupeKey = commentDedupeKey(tenantId, comment.commentId);

  try {
    await prisma.communication.create({
      data: {
        type: "comment",
        direction,
        body: comment.message || "[no text]",
        subject: comment.authorName ?? undefined,
        // The thread is chosen, not searched for: attachToConversation honours an
        // explicit conversationId, and the search it would otherwise run looks
        // for a PERSON's thread — which is exactly what this is not.
        conversationId: thread.id,
        messageId: comment.commentId,
        dedupeKey,
        occurredAt: comment.createdAt ? new Date(comment.createdAt) : undefined,
        ...(comment.attachmentUrl
          ? { attachmentUrl: comment.attachmentUrl, attachmentType: "image" as const }
          : {}),
        userId: actor.id,
        tenantId,
      },
    });
  } catch (error) {
    // Meta redelivers an unacknowledged batch whole, so the same comment
    // arriving twice is routine rather than a fault.
    if (isDedupeKeyConflict(error)) return { status: "duplicate" };
    throw error;
  }

  return { status: "filed", conversationId: thread.id, direction };
}

type Thread = { id: string; mutedAt: Date | null };

/**
 * The post's thread, opening one if this is its first comment.
 *
 * `basePrisma` with an explicit tenant, because this runs inside a webhook whose
 * scope came from the Page id — the row is being created for that tenant rather
 * than found within an ambient one.
 */
async function findOrOpenThread(
  tenantId: string,
  externalRef: string,
  comment: IngestibleComment,
): Promise<Thread> {
  const existing = await basePrisma.conversation.findFirst({
    where: { tenantId, channel: "comment", externalRef },
    select: { id: true, mutedAt: true },
  });
  if (existing) return existing;

  try {
    return await basePrisma.conversation.create({
      data: {
        tenantId,
        channel: "comment",
        externalRef,
        subject: commentThreadSubject(comment),
        unread: true,
        lastDirection: "inbound",
        lastMessageAt: comment.createdAt ? new Date(comment.createdAt) : new Date(),
      },
      select: { id: true, mutedAt: true },
    });
  } catch (error) {
    // Two comments on a cold post, at once. The unique index on
    // (tenantId, channel, externalRef) means exactly one create wins; the loser
    // re-reads rather than splitting the post across two threads.
    const winner = await basePrisma.conversation.findFirst({
      where: { tenantId, channel: "comment", externalRef },
      select: { id: true, mutedAt: true },
    });
    if (winner) return winner;
    throw error;
  }
}

/**
 * Stop (or resume) taking comments for one post.
 *
 * The `feed` subscription is Page-wide and cannot be narrowed at Meta, so this
 * is the only place a busy campaign can be silenced without going blind to
 * every other post. Existing comments stay; only new ones are refused.
 */
export async function setCommentThreadMuted(conversationId: string, muted: boolean): Promise<void> {
  await prisma.conversation.updateMany({
    where: { id: conversationId, channel: "comment" },
    data: { mutedAt: muted ? new Date() : null },
  });
}

/** Best-effort ingest for a webhook: never lets a comment fail the batch. */
export async function recordPostCommentSafely(
  comment: IngestibleComment,
  options: { platform: "facebook" | "instagram"; pageId: string | null },
): Promise<CommentIngestOutcome | null> {
  try {
    return await recordPostComment(comment, options);
  } catch (error) {
    await logError("meta-webhook", error, `comment ${comment.commentId}`).catch(() => {});
    return null;
  }
}
