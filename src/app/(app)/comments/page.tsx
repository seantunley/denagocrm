import { MessagesSquare } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { loadCommentThreads } from "@/lib/commentInbox";
import CommentThreadList from "@/components/CommentThreadList";
import { WorkspaceHero } from "@/components/workspace-hero";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";

export const metadata = { title: "Comments — DenagoCRM" };

/**
 * Public comments on posts and ads — a screen of its own, not a tab in the inbox.
 *
 * ── WHY IT IS SEPARATE ──────────────────────────────────────────────────────
 *
 * The Social inbox answers "who is waiting on us": one customer per thread, a
 * private conversation, an answer owed. Comments answer a different question
 * entirely — a post with a crowd on it, in public, most of whom want nothing.
 * Sharing a screen made each one worse: the public chatter buried the private
 * conversations that need someone, and the moderation view inherited a reply box
 * that could not reply.
 *
 * They also cannot be threaded the same way. The inbox groups by PERSON, and a
 * commenter has no identity we can resolve — their Facebook id is not their
 * Messenger id — so `buildInboxThreads` skips those rows by construction. This
 * screen reads them itself.
 */
export default async function CommentsPage() {
  await requireRoute("/comments");

  const [active, archived] = await Promise.all([
    loadCommentThreads({ archived: false }),
    loadCommentThreads({ archived: true }),
  ]);

  const unread = active.filter((thread) => thread.unread).length;
  const muted = active.filter((thread) => thread.muted).length;
  const total = active.reduce((sum, thread) => sum + thread.messageCount, 0);

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={60} />
      <WorkspaceHero
        icon={MessagesSquare}
        eyebrow="Public conversations"
        title="Comments"
        description="Comments left on your posts and ads. Answer publicly under the post, or privately to turn one into a conversation — and archive a post once it is dealt with."
        stats={[
          { label: "Posts", value: active.length, detail: "With comments" },
          {
            label: "Unread",
            value: unread,
            detail: unread ? "Needs a look" : "You're caught up",
            tone: unread ? "warning" : "success",
          },
          { label: "Comments", value: total, detail: "Across those posts" },
          { label: "Muted", value: muted, detail: muted ? "Not taking new comments" : "None silenced" },
        ]}
      />

      <Tabs
        tabs={[
          {
            key: "active",
            label: "Active",
            count: unread,
            content: <CommentThreadList threads={active} />,
          },
          {
            key: "archived",
            label: "Archived",
            count: archived.length,
            content: (
              <CommentThreadList
                threads={archived}
                emptyMessage="Nothing archived yet. Archive a post once you have dealt with its comments — it leaves this list but keeps listening, so a new comment brings it back."
              />
            ),
          },
        ]}
      />
    </div>
  );
}
