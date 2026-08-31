"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prisma } from "@/lib/db";
import { requireConversationAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { sendPrivateReplyToComment, sendPublicCommentReply } from "@/lib/messenger";
import { commentDedupeKey, privateReplyDedupeKey } from "@/lib/socialComments";
import { setCommentThreadMuted } from "@/lib/commentThreads";
import { deleteCommunicationsAndReconcile } from "@/lib/conversations";
import { isDedupeKeyConflict } from "@/lib/inboundMessageKey";
import { logAudit } from "@/lib/audit";

/**
 * What can be done with a public comment from inside the CRM.
 *
 * File it, answer the person privately or publicly, archive the post once it is
 * dealt with, and silence one that is running hot.
 *
 * The PUBLIC reply needs `pages_manage_engagement`, which not every install
 * has. The screen asks Meta what is actually granted
 * (lib/metaCapabilities.ts) and does not render that button until it is —
 * offering an action the provider will refuse is worse than offering none. The
 * action below still translates a refusal into the exact thing to change,
 * because a server action is reachable directly and must not depend on the UI
 * having hidden it.
 */

/**
 * Send the one private message Meta allows in reply to a comment.
 *
 * ── WHY THIS IS THE POINT OF THE FEATURE ────────────────────────────────────
 *
 * A commenter's Facebook id is not their Messenger id, so there is no way to
 * message them directly and no way to match them to an existing contact. The
 * private reply is the only bridge: it reaches them without us knowing their
 * messaging id, and once they answer, the thread is an ordinary DM against a
 * person the CRM can identify.
 *
 * ── ONE SHOT, AND THE CRM OWNS IT ───────────────────────────────────────────
 *
 * Meta permits exactly one private reply per comment, within seven days. The
 * reservation below means this CRM decides who gets that one attempt, rather
 * than letting two people both call Meta and leaving Meta to refuse the second
 * — by which point the loser has already written a message that went nowhere.
 * See the block inside the function for why the ordering is the whole point.
 */
export async function privateReplyToComment(
  conversationId: string,
  commentId: string,
  text: string,
): Promise<ActionResult> {
  return asActionResult(async () =>
    withActingStaffScope(async () => {
      // The same per-conversation guard every other inbox mutation uses: it
      // checks the permission AND that this conversation is reachable by this
      // user in this workspace. The ids come from the browser, and a server
      // action is a POST endpoint reachable directly.
      const user = await requireConversationAccess(conversationId, "inbox.reply");

      const body = text.trim();
      if (!body) refuse("Write a message before sending it.");
      if (!commentId.trim()) refuse("That comment can no longer be replied to.");

      // …and it must actually be a COMMENT thread. `requireConversationAccess`
      // proves reachability, not kind, and a private reply aimed at a DM thread
      // would be nonsense.
      const thread = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: "comment" },
        // `tenantId` because the reply is stamped with the THREAD's owner rather
        // than the acting scope. `Communication(tenantId, conversationId) →
        // Conversation(tenantId, id)` is a composite foreign key, so a message
        // claiming a different owner than the thread it attaches to cannot be
        // inserted at all — and the thread is the one that already knows.
        select: { id: true, tenantId: true },
      });
      if (!thread) refuse("That comment thread no longer exists.");

      /*
       * ONE PER COMMENT — RESERVED BEFORE THE SEND, NOT RECORDED AFTER IT.
       *
       * Meta allows exactly one private reply to a comment, ever. An earlier
       * version checked for an existing reply, sent, and then wrote the row with
       * a unique key — and claimed the key prevented the race. It did not: two
       * requests can both find nothing, both reach Meta, and only then collide
       * on the insert. A constraint that is evaluated after the side effect
       * cannot prevent the side effect.
       *
       * So the row is written FIRST and acts as the reservation. The unique
       * `dedupeKey` means exactly one caller can create it; the loser is refused
       * before it ever calls Meta. What happens next depends on what Meta says:
       *
       *   refused WITH a response  → it definitely did not send. Release the
       *                              reservation so a corrected attempt is
       *                              possible.
       *   no response at all       → we do not know whether it sent. KEEP the
       *                              reservation. A retry that duplicated a
       *                              delivered message is worse than a reply
       *                              that has to be checked by hand.
       *
       * `deleteCommunicationsAndReconcile` rather than a bare delete, so the
       * thread's counters and last-message state do not drift when a reservation
       * is released.
       */
      const replyKey = thread.tenantId ? privateReplyDedupeKey(thread.tenantId, commentId) : null;
      if (!replyKey) refuse("This comment thread has no workspace, so a reply cannot be recorded against it.");

      try {
        await prisma.communication.create({
          data: {
            type: "comment",
            direction: "outbound",
            body,
            subject: "Private reply",
            conversationId: thread.id,
            // WHICH comment this answers, so the screen can stop offering a
            // reply Meta would refuse. `inReplyTo` already means exactly this.
            inReplyTo: commentId,
            dedupeKey: replyKey,
            userId: user.id,
            tenantId: thread.tenantId,
          },
        });
      } catch (error) {
        if (isDedupeKeyConflict(error)) {
          refuse(
            "Someone has already sent the one private reply Meta allows for this comment. Reply publicly instead.",
          );
        }
        throw error;
      }

      let sent: Awaited<ReturnType<typeof sendPrivateReplyToComment>>;
      try {
        sent = await sendPrivateReplyToComment(commentId, body);
      } catch {
        // No response — a timeout or a dropped connection. Meta may have
        // accepted it. The reservation stays, so nobody sends a second one.
        refuse(
          "The reply could not be confirmed with Meta. It may have been delivered, so it has not been sent again — check the conversation on Facebook.",
        );
      }

      if (!sent.ok) {
        await deleteCommunicationsAndReconcile({ dedupeKey: replyKey });
        refuse(sent.error ?? "Meta refused the private reply.");
      }

      // Confirmed. Stamp the provider's id onto the reservation that is already
      // there — the row was the reservation, so there is nothing more to insert.
      await prisma.communication.updateMany({
        where: { dedupeKey: replyKey },
        data: { messageId: sent.providerMessageId },
      });

      await logAudit({
        action: "comment.private_reply",
        summary: `Replied privately to a comment (${commentId})`,
        userName: user.name,
      });

      revalidatePath("/comments");
      return { success: "Private reply sent — their answer will arrive as a Messenger conversation." };
    }),
  );
}

/**
 * Reply publicly, under the post, where everyone still reading can see it.
 *
 * The counterpart to the private reply, not a replacement for it. A private
 * reply reaches one person once; this answers the question for the whole
 * audience — usually the larger win on an ad.
 *
 * Unlike the private reply there is no one-shot limit and no seven-day window,
 * so this can be used freely. What it DOES need is `pages_manage_engagement`,
 * which this app has not been granted — the send translates Meta's refusal into
 * the specific thing to do about it rather than surfacing "(#200) Permissions
 * error", and nothing is recorded when it fails.
 */
export async function publicReplyToComment(
  conversationId: string,
  commentId: string,
  text: string,
): Promise<ActionResult> {
  return asActionResult(async () =>
    withActingStaffScope(async () => {
      const user = await requireConversationAccess(conversationId, "inbox.reply");

      const body = text.trim();
      if (!body) refuse("Write a reply before sending it.");
      if (!commentId.trim()) refuse("That comment can no longer be replied to.");

      const thread = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: "comment" },
        select: { id: true, tenantId: true },
      });
      if (!thread) refuse("That comment thread no longer exists.");

      const sent = await sendPublicCommentReply(commentId, body);
      if (!sent.ok) refuse(sent.error ?? "Meta refused the reply.");

      // Recorded only on success. Our own reply also comes back through the
      // `feed` webhook as a Page comment, which the ingest files as outbound —
      // so this row carries the provider id and the redelivery is refused by
      // the dedupe key rather than appearing twice.
      await prisma.communication.create({
        data: {
          type: "comment",
          direction: "outbound",
          body,
          subject: "Public reply",
          conversationId: thread.id,
          messageId: sent.providerMessageId,
          // The comment this answers, same as the private reply. Public replies
          // are not one-shot, so this is for reading the thread rather than for
          // enforcement.
          inReplyTo: commentId,
          ...(sent.providerMessageId && thread.tenantId
            ? { dedupeKey: commentDedupeKey(thread.tenantId, sent.providerMessageId) }
            : {}),
          userId: user.id,
          tenantId: thread.tenantId,
        },
      });

      await logAudit({
        action: "comment.public_reply",
        summary: `Replied publicly to a comment (${commentId})`,
        userName: user.name,
      });

      revalidatePath("/comments");
      return { success: "Reply posted under the post." };
    }),
  );
}

/**
 * Archive a post's comment thread, or bring it back.
 *
 * Different from muting, and both are wanted. MUTED stops new comments arriving
 * at all — for a post running hot that nobody needs to read. ARCHIVED means
 * "dealt with": it leaves the queue but keeps listening, so a new comment on an
 * archived post still lands and can bring it back to attention.
 */
export async function setCommentThreadArchived(
  conversationId: string,
  archived: boolean,
): Promise<ActionResult> {
  return asActionResult(async () =>
    withActingStaffScope(async () => {
      const user = await requireConversationAccess(conversationId, "inbox.reply");

      const thread = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: "comment" },
        select: { id: true, subject: true },
      });
      if (!thread) refuse("That comment thread no longer exists.");

      await prisma.conversation.updateMany({
        where: { id: thread.id, channel: "comment" },
        // `status` already carries exactly this meaning for a conversation, so
        // archiving needs no new column — and "closed" is what the rest of the
        // inbox already understands.
        data: { status: archived ? "closed" : "open", ...(archived ? { unread: false } : {}) },
      });

      await logAudit({
        action: archived ? "comment.thread_archived" : "comment.thread_reopened",
        summary: `${archived ? "Archived" : "Reopened"} ${thread.subject ?? "a comment thread"}`,
        userName: user.name,
      });

      revalidatePath("/comments");
      return { success: archived ? "Archived." : "Back in the active list." };
    }),
  );
}

/**
 * Silence, or un-silence, one post's comment thread.
 *
 * A Page `feed` subscription cannot be narrowed at Meta's end, so every post on
 * the Page delivers comments. This is the only way to stop one busy campaign
 * burying the inbox — and it is per-post precisely so that silencing it does not
 * mean going blind to everything else. Existing comments stay; only new ones are
 * refused.
 */
export async function setCommentThreadMute(conversationId: string, muted: boolean): Promise<ActionResult> {
  return asActionResult(async () =>
    withActingStaffScope(async () => {
      const user = await requireConversationAccess(conversationId, "inbox.reply");

      const thread = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: "comment" },
        select: { id: true, subject: true },
      });
      if (!thread) refuse("That comment thread no longer exists.");

      await setCommentThreadMuted(thread.id, muted);
      await logAudit({
        action: muted ? "comment.thread_muted" : "comment.thread_unmuted",
        summary: `${muted ? "Muted" : "Unmuted"} ${thread.subject ?? "a comment thread"}`,
        userName: user.name,
      });

      revalidatePath("/inbox");
      return {
        success: muted
          ? "Muted — new comments on this post will not reach the inbox."
          : "Unmuted — new comments on this post will reach the inbox again.",
      };
    }),
  );
}
