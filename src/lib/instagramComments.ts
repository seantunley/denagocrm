/**
 * Instagram comments in (Instagram follow gate, part 2; Sean, 2026-11-21). Pure.
 *
 * Instagram delivers a comment on the business account's post or reel as a `comments` change on the `instagram`
 * object, with the business account's id as `entry.id`:
 *   { field: "comments", value: { id, text, parent_id?, from: { id, username }, media: { id, media_product_type } } }
 * This turns it into the same IngestibleComment a Facebook Page comment becomes (lib/socialComments.ts), so the
 * inbox files it the same way, under its post.
 */
import type { CommentDecision } from "./socialComments";

export type InstagramCommentValue = {
  id?: string;
  text?: string;
  parent_id?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
};

export function decideInstagramComment(value: InstagramCommentValue | null | undefined): CommentDecision {
  const v = value ?? {};
  const commentId = String(v.id ?? "").trim();
  if (!commentId) return { ok: false, reason: "no-comment-id" };
  const postId = String(v.media?.id ?? "").trim();
  if (!postId) return { ok: false, reason: "no-post-id" };
  const message = String(v.text ?? "").trim();
  if (!message) return { ok: false, reason: "empty" };
  return {
    ok: true,
    comment: {
      commentId,
      postId,
      // Instagram's parent_id is always another COMMENT (a reply); a top-level comment has none.
      parentId: v.parent_id ? String(v.parent_id) : null,
      message,
      authorId: v.from?.id ? String(v.from.id) : null,
      // An Instagram handle — shown with its @.
      authorName: v.from?.username ? `@${String(v.from.username)}` : null,
      createdAt: null,
      attachmentUrl: null,
      permalink: null,
    },
  };
}
