"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prisma } from "@/lib/db";
import { requireConversationAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { sendPrivateReplyToComment } from "@/lib/messenger";
import { setCommentThreadMuted } from "@/lib/commentThreads";
import { logAudit } from "@/lib/audit";

/**
 * What can be done with a public comment from inside the CRM.
 *
 * Phase one is deliberately narrow: file it, silence a noisy post, and convert
 * a commenter into a conversation. Replying PUBLICLY, hiding and deleting all
 * need `pages_manage_engagement`, which this install has not been granted — so
 * they are not offered rather than offered and failing.
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
 * ── ONE SHOT ────────────────────────────────────────────────────────────────
 *
 * Meta permits exactly one private reply per comment, within seven days. A
 * refusal is therefore FINAL — retrying the same comment will always fail — so
 * the outcome is recorded on the thread either way, and the person is told
 * plainly rather than being left to press the button again.
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

      const sent = await sendPrivateReplyToComment(commentId, body);
      if (!sent.ok) refuse(sent.error ?? "Meta refused the private reply.");

      // Filed on the COMMENT thread, not on a DM thread: no DM thread exists
      // yet, and will not until they answer. Recording it here is what stops a
      // second person sending the reply Meta would refuse anyway.
      await prisma.communication.create({
        data: {
          type: "comment",
          direction: "outbound",
          body,
          subject: "Private reply",
          conversationId: thread.id,
          messageId: sent.providerMessageId,
          userId: user.id,
          tenantId: thread.tenantId,
        },
      });

      await logAudit({
        action: "comment.private_reply",
        summary: `Replied privately to a comment (${commentId})`,
        userName: user.name,
      });

      revalidatePath("/inbox");
      return { success: "Private reply sent — their answer will arrive as a Messenger conversation." };
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
