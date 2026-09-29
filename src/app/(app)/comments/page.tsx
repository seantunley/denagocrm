import { MessagesSquare } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { loadCommentThreads } from "@/lib/commentInbox";
import CommentThreadList from "@/components/CommentThreadList";
import { WorkspaceHero } from "@/components/workspace-hero";
import AutoRefresh from "@/components/AutoRefresh";
import Tabs from "@/components/Tabs";
import { pageCapabilities } from "@/lib/metaCapabilities";
import { Surface } from "@/components/visual-system";

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

  const [active, archived, capabilities] = await Promise.all([
    loadCommentThreads({ archived: false }),
    loadCommentThreads({ archived: true }),
    // Asked, not assumed. Public replies need pages_manage_engagement; if Meta
    // has not granted it, the button is not rendered and the notice below says
    // exactly how to change that.
    pageCapabilities(),
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

      {!capabilities.canManageEngagement && (
        <Surface className="border-amber-500/30 bg-amber-500/[0.06] p-4">
          <p className="text-sm font-medium text-amber-200">Public replies are not enabled yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Replying <b>privately</b> works now. To also reply <b>under the post</b>, the Denago CRM app needs
            Meta&apos;s <code className="rounded bg-muted px-1">pages_manage_engagement</code> permission:
            request it in the Meta app dashboard under <b>App Review → Permissions and Features</b>, then
            reconnect the Page in Settings → Integrations.
            {capabilities.checkedAt
              ? ` Last checked ${capabilities.checkedAt.toLocaleString("en-ZA")}.`
              : " Meta has not been asked yet — this updates once the Page token is readable."}
          </p>
        </Surface>
      )}

      <Tabs
        tabs={[
          {
            key: "active",
            label: "Active",
            count: unread,
            content: <CommentThreadList threads={active} canReplyPublicly={capabilities.canManageEngagement} />,
          },
          {
            key: "archived",
            label: "Archived",
            count: archived.length,
            content: (
              <CommentThreadList
                threads={archived}
                canReplyPublicly={capabilities.canManageEngagement}
                emptyMessage="Nothing archived yet. Archive a post once you have dealt with its comments — it leaves this list but keeps listening, so a new comment brings it back."
              />
            ),
          },
        ]}
      />
    </div>
  );
}
