"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { BellOff, Bell, ExternalLink, Send } from "lucide-react";
import { Surface } from "@/components/visual-system";
import { privateReplyToComment, setCommentThreadMute } from "@/app/actions/comments";
import type { CommentThread } from "@/lib/commentInbox";

/**
 * The comments mailbox: one card per POST, with its comments beneath it.
 *
 * Deliberately not the DM thread list. The affordances are different, because
 * the situation is:
 *
 *   * a DM is one customer waiting on an answer; a post is a crowd, and most of
 *     them are not waiting on anything;
 *   * you cannot simply "reply" to a commenter. Their Facebook id is not their
 *     messaging id, so the only way to reach them is Meta's private reply —
 *     ONE message, within seven days, and it is what OPENS a conversation
 *     rather than continuing one;
 *   * a busy post needs silencing, which a DM never does.
 */
export default function CommentThreadList({ threads }: { threads: CommentThread[] }) {
  if (threads.length === 0) {
    return (
      <Surface className="p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No comments yet. Comments on Facebook posts — including on ads — appear here once the
          Page&apos;s <b>feed</b> webhook field is subscribed in the Meta app dashboard.
        </p>
      </Surface>
    );
  }

  return (
    <div className="space-y-4">
      {threads.map((thread) => (
        <CommentThreadCard key={thread.conversationId} thread={thread} />
      ))}
    </div>
  );
}

function CommentThreadCard({ thread }: { thread: CommentThread }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const permalink = thread.externalRef?.startsWith("facebook:")
    ? `https://www.facebook.com/${thread.externalRef.slice("facebook:".length)}`
    : null;

  function toggleMute() {
    startTransition(async () => {
      const result = await setCommentThreadMute(thread.conversationId, !thread.muted).catch(() => null);
      if (!result || "error" in result) {
        toast.error(result && "error" in result ? result.error : "Couldn't change that.");
        return;
      }
      toast.success(result.success ?? "Updated");
      router.refresh();
    });
  }

  return (
    <Surface className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {thread.subject}
            {thread.unread && <span className="badge ml-2 bg-emerald-500/15 text-emerald-300">New</span>}
            {thread.muted && <span className="badge ml-2 bg-amber-500/15 text-amber-300">Muted</span>}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {thread.messageCount} comment{thread.messageCount === 1 ? "" : "s"} · last{" "}
            {thread.lastAt.toLocaleString("en-ZA")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {permalink && (
            <a href={permalink} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
              <ExternalLink className="size-4" />
              Open post
            </a>
          )}
          <button type="button" className="btn-secondary btn-sm" onClick={toggleMute} disabled={pending}>
            {thread.muted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
            {thread.muted ? "Unmute" : "Mute"}
          </button>
        </div>
      </div>

      <ul className="space-y-2">
        {thread.comments.map((comment) => (
          <CommentRow key={comment.id} conversationId={thread.conversationId} comment={comment} />
        ))}
      </ul>
    </Surface>
  );
}

function CommentRow({
  conversationId,
  comment,
}: {
  conversationId: string;
  comment: CommentThread["comments"][number];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const outbound = comment.direction === "outbound";

  function send() {
    if (!comment.commentId || !text.trim()) return;
    startTransition(async () => {
      const result = await privateReplyToComment(conversationId, comment.commentId!, text).catch(() => null);
      if (!result || "error" in result) {
        toast.error(result && "error" in result ? result.error : "Couldn't send that.");
        return;
      }
      toast.success(result.success ?? "Sent");
      setText("");
      setOpen(false);
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

      {/* A private reply is only offered on a customer's comment, and only once
          Meta has given us a comment id to address it to. Replying to our own
          comment would be meaningless. */}
      {!outbound && comment.commentId && (
        <div className="mt-2">
          {!open ? (
            <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
              <Send className="size-4" />
              Reply privately
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Meta allows <b>one</b> private message per comment, within 7 days. Their answer arrives
                as a Messenger conversation.
              </p>
              <textarea
                className="input min-h-20 resize-y text-sm"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Thanks for the comment — happy to help. What would you like to know?"
              />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={send}
                  disabled={pending || !text.trim()}
                >
                  {pending ? "Sending…" : "Send private reply"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
