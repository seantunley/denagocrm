/**
 * Deciding what, out of a Page's `feed` webhook, is a comment worth filing.
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ─────────────────────────────────────
 *
 * `feed` is a firehose. Meta's own description is "nearly all changes to a
 * Page's feed" — posts, shares, likes, reactions, edits, deletions, status
 * changes — and comments are one item type among many. Subscribing to it
 * without a filter fills a working inbox with reaction noise on the first busy
 * campaign, which is the fastest way to make people stop opening the inbox at
 * all.
 *
 * So the filter is the feature, and it lives here as an ordinary function over
 * a plain object: it can be RUN against real payload shapes in a test rather
 * than reasoned about inside a webhook handler that needs a signature, a tenant
 * scope and a database to reach.
 *
 * ── ADS ─────────────────────────────────────────────────────────────────────
 *
 * Comments on ads arrive here too, and need no special handling. Meta's
 * documentation is explicit: "Webhooks are not sent for Ad Posts, but are sent
 * for Comments on Ad Posts." A comment on a boosted post or on a dark post
 * created straight in Ads Manager is delivered on this same field, in this same
 * shape.
 */

/** The `value` of one `feed` change, as far as we care about it. */
export type FeedChangeValue = {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  created_time?: number;
  from?: { id?: string; name?: string };
  photo?: string;
  video?: string;
  permalink_url?: string;
};

/** A comment we intend to file. Everything needed, nothing raw. */
export type IngestibleComment = {
  commentId: string;
  postId: string;
  /** The comment this one replies to, when it is a reply rather than top-level. */
  parentId: string | null;
  message: string;
  authorId: string | null;
  authorName: string | null;
  /** Milliseconds. `created_time` is delivered in SECONDS. */
  createdAt: number | null;
  attachmentUrl: string | null;
  permalink: string | null;
};

/**
 * Why a `feed` change was not filed. Returned rather than thrown, because
 * "this was a reaction" is the ordinary case and not a problem.
 */
export type CommentRejection =
  | "not-a-comment"
  | "not-an-addition"
  | "no-comment-id"
  | "no-post-id"
  | "empty";

export type CommentDecision =
  | { ok: true; comment: IngestibleComment }
  | { ok: false; reason: CommentRejection };

/**
 * `verb` values that mean "this comment now exists and did not before".
 *
 * Deliberately NOT `edit`, `remove` or `hide`. An edit arriving as a new row
 * would show the same comment twice with different words, which reads as the
 * customer having said both. Editing history is not what an inbox is for, and a
 * removal is not something to file at all.
 */
const ADDING_VERBS: ReadonlySet<string> = new Set(["add", "added"]);

export function decideComment(value: FeedChangeValue | null | undefined): CommentDecision {
  const v = value ?? {};

  // The firehose filter, in order of how often each fires. Likes and reactions
  // are by far the most common `feed` change on a page that is advertising.
  if (v.item !== "comment") return { ok: false, reason: "not-a-comment" };
  if (!ADDING_VERBS.has(String(v.verb ?? ""))) return { ok: false, reason: "not-an-addition" };

  const commentId = String(v.comment_id ?? "").trim();
  if (!commentId) return { ok: false, reason: "no-comment-id" };

  const postId = String(v.post_id ?? "").trim();
  // Without the post there is no thread to file this into. Dropping it is
  // better than inventing a thread nobody can find their way back to.
  if (!postId) return { ok: false, reason: "no-post-id" };

  const message = String(v.message ?? "").trim();
  const attachmentUrl = String(v.photo ?? v.video ?? "").trim() || null;
  // A comment that is only a sticker or a photo has no message but is still a
  // customer saying something. Only a comment with NEITHER is empty.
  if (!message && !attachmentUrl) return { ok: false, reason: "empty" };

  return {
    ok: true,
    comment: {
      commentId,
      postId,
      // Meta sets parent_id to the POST for a top-level comment, and to the
      // parent COMMENT for a reply. Treat "parent is the post" as top-level, so
      // callers can tell a reply from an original without knowing that quirk.
      parentId: v.parent_id && v.parent_id !== postId ? String(v.parent_id) : null,
      message,
      authorId: v.from?.id ? String(v.from.id) : null,
      authorName: v.from?.name ? String(v.from.name) : null,
      // SECONDS on the wire. Multiplying is the whole reason this is not read
      // straight into a Date at the call site.
      createdAt: typeof v.created_time === "number" ? v.created_time * 1000 : null,
      attachmentUrl,
      permalink: v.permalink_url ? String(v.permalink_url) : null,
    },
  };
}

/**
 * Whether this comment is the Page talking, rather than a customer.
 *
 * Not dropped — RECORDED AS OUTBOUND. A reply typed into Facebook itself is a
 * real answer to the customer, and a thread that showed only their side would
 * misrepresent the conversation and invite somebody to answer twice. It is the
 * same reasoning `metaEcho` applies to DMs, with the opposite conclusion,
 * because unlike a DM echo this is the only record we will ever get of it.
 */
export function isOwnPageComment(comment: IngestibleComment, pageId: string | null | undefined): boolean {
  const page = String(pageId ?? "").trim();
  return page !== "" && comment.authorId === page;
}

/**
 * The platforms a comment thread can belong to.
 *
 * Facebook is the only one ingesting today. The others are here because the
 * thread key already carries the platform, so nothing about the screen, the
 * icon or the storage has to change when Instagram comments are switched on —
 * only the webhook branch that produces them.
 */
export type CommentPlatform = "facebook" | "instagram" | "x";

/** The stable key for one post's comment thread. */
export function commentThreadRef(platform: CommentPlatform, postId: string): string {
  return `${platform}:${postId}`;
}

/** The platform a thread key names, or null when it names none we know. */
export function commentPlatform(externalRef: string | null | undefined): CommentPlatform | null {
  const prefix = (externalRef ?? "").split(":")[0];
  return prefix === "facebook" || prefix === "instagram" || prefix === "x" ? prefix : null;
}

/** The post id, without its platform prefix. */
export function commentPostId(externalRef: string | null | undefined): string | null {
  const [prefix, ...rest] = (externalRef ?? "").split(":");
  const id = rest.join(":");
  return commentPlatform(prefix) && id ? id : null;
}

const PLATFORM_PRESENTATION: Record<CommentPlatform, { label: string; icon: string }> = {
  facebook: { label: "Facebook", icon: "/branding/social-facebook.png" },
  instagram: { label: "Instagram", icon: "/branding/social-instagram.png" },
  x: { label: "X", icon: "/branding/social-x.svg" },
};

/** How a platform is named and shown. The same assets the inbox already uses. */
export function commentPlatformPresentation(platform: CommentPlatform | null): { label: string; icon: string | null } {
  if (!platform) return { label: "Unknown", icon: null };
  return PLATFORM_PRESENTATION[platform];
}

/**
 * A link back to the post itself, when the platform has one we can build.
 *
 * Facebook post ids are addressable by URL. Instagram's are not — a media id is
 * not its shortcode — so rather than emit a link that 404s, there is none.
 */
export function commentPostUrl(externalRef: string | null | undefined): string | null {
  const platform = commentPlatform(externalRef);
  const postId = commentPostId(externalRef);
  if (!platform || !postId) return null;
  return platform === "facebook" ? `https://www.facebook.com/${postId}` : null;
}

/**
 * The idempotency key for a filed comment.
 *
 * Meta redelivers a webhook until it is acknowledged, and a batch containing
 * several comments is replayed whole when any one of them fails — so the same
 * comment arrives more than once as a matter of routine, not as an error. The
 * comment id is globally unique at Meta; the tenant is included so two
 * workspaces could never collide on one.
 */
export function commentDedupeKey(tenantId: string, commentId: string): string {
  return `fbcomment:${tenantId}:${commentId}`;
}

/** What the thread is called in the inbox before anyone renames it. */
export function commentThreadSubject(comment: IngestibleComment): string {
  return `Comment thread — post ${comment.postId.split("_").pop() ?? comment.postId}`;
}
