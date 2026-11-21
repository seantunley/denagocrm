/**
 * Threads comments in (Sean, 2026-11-21). Pure.
 *
 * A workspace's Threads app delivers replies to its posts as topic `moderate`, field `replies`:
 *   { app_id, topic, target_id, time, values: [{ field: "replies", value: { id, username, text, replied_to?: { id },
 *     root_post: { id, owner_id, username }, timestamp } }] }
 * `values` arrives as an array (Meta's docs show one object — both are accepted). Each reply becomes the same
 * IngestibleComment a Facebook or Instagram comment does, filed under its post. The account's OWN replies (its
 * username is the post's) are skipped: the inbox records those when it sends them.
 *
 * Shapes as ChatbotX's working Threads integration reads them.
 */
import type { IngestibleComment } from "./socialComments";

export type ThreadsReply = { accountId: string; comment: IngestibleComment };

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function threadsRepliesFrom(payload: unknown, expectedAppId: string): ThreadsReply[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as { app_id?: unknown; topic?: unknown; values?: unknown; time?: unknown };
  // Only this workspace's own app, and only the replies topic.
  if (!expectedAppId || str(p.app_id) !== expectedAppId || str(p.topic) !== "moderate") return [];
  const values = Array.isArray(p.values) ? p.values : p.values ? [p.values] : [];
  const out: ThreadsReply[] = [];
  for (const entry of values) {
    const e = entry as { field?: unknown; value?: Record<string, unknown> } | null;
    if (!e || str(e.field) !== "replies" || !e.value) continue;
    const v = e.value;
    const root = (v.root_post ?? {}) as Record<string, unknown>;
    const commentId = str(v.id);
    const postId = str(root.id);
    const accountId = str(root.owner_id);
    const username = str(v.username);
    const text = str(v.text);
    if (!commentId || !postId || !accountId || !username || !text) continue;
    // Our own reply under our own post: recorded by the inbox when it was sent.
    if (username.toLowerCase() === str(root.username).toLowerCase()) continue;
    const repliedTo = str((v.replied_to as Record<string, unknown> | undefined)?.id);
    const at = Date.parse(str(v.timestamp));
    out.push({
      accountId,
      comment: {
        commentId,
        postId,
        // A reply to another reply keeps it; a reply straight to the post is top-level.
        parentId: repliedTo && repliedTo !== postId ? repliedTo : null,
        message: text,
        authorId: username.toLowerCase(),
        authorName: `@${username}`,
        createdAt: Number.isFinite(at) ? at : typeof p.time === "number" ? p.time * 1000 : null,
        attachmentUrl: null,
        permalink: null,
      },
    });
  }
  return out;
}
