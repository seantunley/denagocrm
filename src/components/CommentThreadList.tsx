"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Send,
} from "lucide-react";
import { Surface } from "@/components/visual-system";
import {
  privateReplyToComment,
  publicReplyToComment,
  setCommentThreadArchived,
  setCommentThreadMute,
} from "@/app/actions/comments";
import type { CommentThread } from "@/lib/commentInbox";

/**
 * The comments screen: one card per POST, collapsible, with its comments inside.
 *
 * Deliberately not the DM thread list. The affordances differ because the
 * situation does:
 *
 *   * a DM is one customer waiting on an answer; a post is a crowd, and most of
 *     them are not waiting on anything — so a post COLLAPSES, and only the ones
 *     with something new are open by default;
 *   * a commenter can be answered two ways, and they are not substitutes. A
 *     PUBLIC reply answers the question for everyone still reading, which on an
 *     ad is the larger audience. A PRIVATE reply reaches one person, once, and
 *     is the only thing that turns them into a conversation the CRM can follow;
 *   * ARCHIVE means dealt with, MUTE means stop listening. Both exist because a
 *     post you have finished with and a post that will not stop are different
 *     problems.
 */
export default function CommentThreadList({
  threads,
  emptyMessage,
  canReplyPublicly,
}: {
  threads: CommentThread[];
  emptyMessage?: string;
  /**
   * Whether Meta has granted `pages_manage_engagement`. Asked, not assumed —
   * see lib/metaCapabilities.ts. When it has not, the public-reply button is
   * NOT rendered: offering an action the provider will refuse is worse than
   * offering none, because somebody writes the answer first and finds out
   * afterwards.
   */
  canReplyPublicly: boolean;
}) {
  if (threads.length === 0) {
    return (
      <Surface className="p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {emptyMessage ??
            "No comments yet. Comments on Facebook posts — including on ads — appear here once the Page's feed webhook field is subscribed in the Meta app dashboard."}
        </p>
      </Surface>
    );
  }

  return (
    <div className="space-y-3">
      {threads.map((thread) => (
        <CommentThreadCard key={thread.conversationId} thread={thread} canReplyPublicly={canReplyPublicly} />
      ))}
    </div>
  );
}

function CommentThreadCard({
  thread,
  canReplyPublicly,
}: {
  thread: CommentThread;
  canReplyPublicly: boolean;
}) {
  const router = useRouter();
  // Open when there is something new, closed otherwise. A screen of expanded
  // posts is unreadable the moment a campaign runs, which is the case this
  // screen exists for.
  const [open, setOpen] = useState(thread.unread && !thread.archived);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ success?: string } | { error: string } | void>) {
    startTransition(async () => {
      const result = await action().catch(() => null);
      if (!result || "error" in result) {
        toast.error(result && "error" in result ? result.error : "Couldn't do that.");
        return;
      }
      toast.success(result.success ?? "Updated");
      router.refresh();
    });
  }

  return (
    <Surface className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
          {/* The platform this post is on. Same assets the inbox channel cards
              use, so Facebook, Instagram and X read identically in both places. */}
          {thread.platformIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thread.platformIcon}
              alt={thread.platformLabel}
              title={thread.platformLabel}
              className="size-6 shrink-0 rounded-md"
            />
          ) : (
            <Globe className="size-5 shrink-0 text-muted-foreground" aria-label={thread.platformLabel} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {thread.subject}
              {thread.unread && <span className="badge ml-2 bg-emerald-500/15 text-emerald-300">New</span>}
              {thread.muted && <span className="badge ml-2 bg-amber-500/15 text-amber-300">Muted</span>}
              {thread.archived && <span className="badge ml-2 bg-muted text-muted-foreground">Archived</span>}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              {thread.platformLabel} · {thread.messageCount} comment{thread.messageCount === 1 ? "" : "s"} · last{" "}
              {thread.lastAt.toLocaleString("en-ZA")}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {thread.postUrl && (
            <a href={thread.postUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
              <ExternalLink className="size-4" />
              Open post
            </a>
          )}
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={pending}
            title={thread.muted ? "Take new comments again" : "Stop taking new comments on this post"}
            onClick={() => run(() => setCommentThreadMute(thread.conversationId, !thread.muted))}
          >
            {thread.muted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
            {thread.muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={pending}
            title={thread.archived ? "Put this post back in the active list" : "Done with this post"}
            onClick={() => run(() => setCommentThreadArchived(thread.conversationId, !thread.archived))}
          >
            {thread.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            {thread.archived ? "Restore" : "Archive"}
          </button>
        </div>
      </div>

      {open && (
        <ul className="space-y-2 border-t border-border px-3 pb-3 pt-3">
          {thread.comments.map((comment) => (
            <CommentRow
              key={comment.id}
              conversationId={thread.conversationId}
              comment={comment}
              canReplyPublicly={canReplyPublicly}
            />
          ))}
        </ul>
      )}
    </Surface>
  );
}

type ReplyMode = "public" | "private" | null;

function CommentRow({
  conversationId,
  comment,
  canReplyPublicly,
}: {
  conversationId: string;
  comment: CommentThread["comments"][number];
  canReplyPublicly: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<ReplyMode>(null);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const outbound = comment.direction === "outbound";

  function send() {
    if (!comment.commentId || !text.trim() || !mode) return;
    const commentId = comment.commentId;
    startTransition(async () => {
      const result = await (mode === "public"
        ? publicReplyToComment(conversationId, commentId, text)
        : privateReplyToComment(conversationId, commentId, text)
      ).catch(() => null);
      if (!result || "error" in result) {
        toast.error(result && "error" in result ? result.error : "Couldn't send that.");
        return;
      }
      toast.success(result.success ?? "Sent");
      setText("");
      setMode(null);
      router.refresh();
    });
  }

  return (
    <li className={`rounded-lg border border-border p-2.5 ${outbound ? "bg-primary/5" : "bg-muted/30"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium">{outbound ? "You" : comment.author ?? "Someone"}</p>
        <p className="shrink-0 text-[10px] text-muted-foreground">{comment.at.toLocaleString("en-ZA")}</p>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>

      {/* Replies are offered on a customer's comment only, and only once the
          platform has given us an id to address them to. Replying to our own
          comment would be meaningless. */}
      {!outbound && comment.commentId && (
        <div className="mt-2">
          {mode === null ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Only when Meta has actually granted the permission to write a
                  comment. Otherwise the button is absent and the screen says
                  what to enable — see the note above the list. */}
              {canReplyPublicly && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setMode("public")}>
                  <Globe className="size-4" />
                  Reply publicly
                </button>
              )}
              {/* Meta allows ONE private reply per comment, ever. Once it is
                  spent the button goes, rather than being offered to the next
                  person who looks and refused by Meta after they have written
                  their message. */}
              {comment.privateReplied ? (
                <span className="text-[11px] text-muted-foreground">
                  Private reply already sent — Meta allows only one.
                </span>
              ) : (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setMode("private")}>
                  <Send className="size-4" />
                  Reply privately
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                {mode === "public" ? (
                  <>Posted under the post, where everyone reading it can see your answer.</>
                ) : (
                  <>
                    Meta allows <b>one</b> private message per comment, within 7 days. Their answer arrives as
                    a Messenger conversation.
                  </>
                )}
              </p>
              <textarea
                className="input min-h-20 resize-y text-sm"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  mode === "public"
                    ? "Thanks for asking — the Rover XL starts at R89 900 including delivery."
                    : "Thanks for the comment — happy to help. What would you like to know?"
                }
              />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setMode(null)} disabled={pending}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={send}
                  disabled={pending || !text.trim()}
                >
                  {pending ? "Sending…" : mode === "public" ? "Post reply" : "Send private reply"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
