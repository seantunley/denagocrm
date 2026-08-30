import { MessagesSquare } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { loadCommentThreads } from "@/lib/commentInbox";
import CommentThreadList from "@/components/CommentThreadList";
import { WorkspaceHero } from "@/components/workspace-hero";
import AutoRefresh from "@/components/AutoRefresh";

export const metadata = { title: "Comments — DenagoCRM" };

/**
 * Public comments on posts and ads — a screen of its own, not a tab in the inbox.
 *
 * ── WHY IT IS SEPARATE ──────────────────────────────────────────────────────
 *
 * The Social inbox answers "who is waiting on us": one customer per thread, a
 * private conversation, and an answer owed. Comments answer a different
 * question entirely — a post with a crowd on it, in public, most of whom want
 * nothing. Sharing a screen makes each one worse: the public chatter buries the
 * private conversations that need someone, and the comment moderation view
 * inherits a reply box that cannot reply.
 *
 * They also cannot be threaded the same way. The inbox groups by PERSON, and a
 * commenter has no identity we can resolve — their Facebook id is not their
 * Messenger id — so `buildInboxThreads` skips those rows by construction. This
 * screen reads them itself.
 */
export default async function CommentsPage() {
  await requireRoute("/comments");
  const threads = await loadCommentThreads();

  const unread = threads.filter((thread) => thread.unread).length;
  const muted = threads.filter((thread) => thread.muted).length;
  const total = threads.reduce((sum, thread) => sum + thread.messageCount, 0);

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={60} />
      <WorkspaceHero
        icon={MessagesSquare}
        eyebrow="Public conversations"
        title="Comments"
        description="Comments left on your Facebook posts and ads. Reply privately to turn one into a conversation, or mute a post that is running hot."
        stats={[
          { label: "Posts", value: threads.length, detail: "With comments" },
          { label: "Unread", value: unread, detail: unread ? "Needs a look" : "You're caught up", tone: unread ? "warning" : "success" },
          { label: "Comments", value: total, detail: "Across those posts" },
          { label: "Muted", value: muted, detail: muted ? "Not taking new comments" : "None silenced" },
        ]}
      />
      <CommentThreadList threads={threads} />
    </div>
  );
}
