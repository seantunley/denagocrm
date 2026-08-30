import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  commentDedupeKey,
  commentThreadRef,
  commentThreadSubject,
  decideComment,
  isOwnPageComment,
  type FeedChangeValue,
} from "../src/lib/socialComments";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * `feed` is a firehose — Meta's own words are "nearly all changes to a Page's
 * feed". The filter is the feature: without it the first busy campaign fills a
 * working inbox with reaction noise and people stop opening it.
 */

const comment = (over: Partial<FeedChangeValue> = {}): FeedChangeValue => ({
  item: "comment",
  verb: "add",
  comment_id: "1122334455_9988",
  post_id: "998877_112233",
  message: "How much for the Rover XL?",
  created_time: 1_756_500_000,
  from: { id: "7788990011", name: "Thandi M" },
  ...over,
});

// ── The filter ──────────────────────────────────────────────────────────────

test("a real comment is filed", () => {
  const decision = decideComment(comment());
  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.comment.message, "How much for the Rover XL?");
  assert.equal(decision.ok && decision.comment.authorName, "Thandi M");
});

test("THE NOISE IS REFUSED — likes, reactions, shares, posts and status changes", () => {
  // Every one of these arrives on `feed`. None of them belongs in an inbox.
  for (const item of ["like", "reaction", "share", "status", "post", "photo", "video"]) {
    const decision = decideComment(comment({ item }));
    assert.equal(decision.ok, false, `${item} must not become an inbox message`);
    assert.equal(decision.ok === false && decision.reason, "not-a-comment");
  }
});

test("an edit or a deletion is not a new comment", () => {
  // An edit filed as a new row shows the same comment twice with different
  // words, which reads as the customer having said both.
  for (const verb of ["edit", "edited", "remove", "removed", "hide", "unhide"]) {
    const decision = decideComment(comment({ verb }));
    assert.equal(decision.ok, false, `verb "${verb}" must not create a message`);
    assert.equal(decision.ok === false && decision.reason, "not-an-addition");
  }
});

test("a comment with no post has nowhere to be filed", () => {
  const decision = decideComment(comment({ post_id: undefined }));
  assert.equal(decision.ok === false && decision.reason, "no-post-id");
});

test("a comment with neither text nor media is nothing to show", () => {
  assert.equal(decideComment(comment({ message: "   " })).ok, false);
});

test("…but a photo-only comment IS a customer saying something", () => {
  const decision = decideComment(comment({ message: "", photo: "https://scontent/x.jpg" }));
  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.comment.attachmentUrl, "https://scontent/x.jpg");
});

test("a missing or malformed value is refused rather than thrown at", () => {
  assert.equal(decideComment(null).ok, false);
  assert.equal(decideComment(undefined).ok, false);
  assert.equal(decideComment({}).ok, false);
});

// ── Shape ───────────────────────────────────────────────────────────────────

test("created_time is SECONDS and becomes milliseconds", () => {
  const decision = decideComment(comment({ created_time: 1_756_500_000 }));
  assert.equal(decision.ok && decision.comment.createdAt, 1_756_500_000_000);
});

test("a top-level comment has no parent, a reply does", () => {
  // Meta sets parent_id to the POST for a top-level comment — treating that as
  // a parent would make every comment look like a reply to itself.
  const top = decideComment(comment({ parent_id: "998877_112233" }));
  assert.equal(top.ok && top.comment.parentId, null);

  const reply = decideComment(comment({ parent_id: "1122334455_0001" }));
  assert.equal(reply.ok && reply.comment.parentId, "1122334455_0001");
});

// ── Our own voice ───────────────────────────────────────────────────────────

test("the Page's own comment is recognised, so it can be filed as OUTBOUND", () => {
  const decision = decideComment(comment({ from: { id: "993949857137664", name: "Denago" } }));
  assert.ok(decision.ok);
  assert.equal(isOwnPageComment(decision.comment, "993949857137664"), true);
  assert.equal(isOwnPageComment(decision.comment, "999999999"), false);
});

test("an unknown page id never makes a customer's comment look like ours", () => {
  const decision = decideComment(comment());
  assert.ok(decision.ok);
  assert.equal(isOwnPageComment(decision.comment, null), false);
  assert.equal(isOwnPageComment(decision.comment, ""), false);
});

// ── Keys ────────────────────────────────────────────────────────────────────

test("one thread per post, one message per comment", () => {
  assert.equal(commentThreadRef("facebook", "998877_112233"), "facebook:998877_112233");
  assert.equal(commentDedupeKey("tenant_a", "1122_9988"), "fbcomment:tenant_a:1122_9988");
  // Two workspaces could never collide on one comment id.
  assert.notEqual(commentDedupeKey("tenant_a", "x"), commentDedupeKey("tenant_b", "x"));
});

test("the thread is named after its post", () => {
  const decision = decideComment(comment());
  assert.ok(decision.ok);
  assert.match(commentThreadSubject(decision.comment), /112233/);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the webhook filters before filing, and handles the feed field at all", () => {
  const route = shipped("src/app/api/webhooks/meta/route.ts");
  assert.match(route, /change\.field === "feed"/, "comments arrive on the feed field");
  assert.match(route, /decideComment\(/, "…and must be filtered before anything is filed");
  assert.match(route, /recordPostCommentSafely\(/);
  // The Page id is the tenant discriminator AND how our own reply is told apart.
  assert.match(route, /withChannelTenantScope\(\s*"messenger",\s*pageId/);
});

test("comments are filed against no contact — a commenter cannot be identified", () => {
  /*
   * A commenter's Facebook id is NOT their Messenger id, so there is no way to
   * match them to an existing contact. Guessing would put a stranger's public
   * comment onto a real customer's timeline.
   */
  const ingest = shipped("src/lib/commentThreads.ts");
  assert.doesNotMatch(ingest, /contactId:/, "a comment must not be attached to a contact");
  assert.doesNotMatch(ingest, /createLeadRecord|createIntakeLead/, "…nor create a lead");
});

test("a redelivered comment is a duplicate, not a second message", () => {
  const ingest = shipped("src/lib/commentThreads.ts");
  assert.match(ingest, /commentDedupeKey\(/);
  assert.match(ingest, /isDedupeKeyConflict\(error\)/);
});

test("a muted post stops taking new comments", () => {
  const ingest = shipped("src/lib/commentThreads.ts");
  assert.match(ingest, /if \(thread\.mutedAt\) return \{ status: "muted" \};/);
});

test("comments live on their own channel, never mixed into the DM mailbox", () => {
  assert.match(shipped("src/lib/conversations.ts"), /comment: "comment"/);
  assert.match(shipped("src/lib/commentThreads.ts"), /channel: "comment"/);
  // And are read separately: the DM list threads by person and skips these rows.
  assert.match(shipped("src/lib/commentInbox.ts"), /channel: "comment"/);
});

test("the private reply is addressed to the COMMENT, not to a person", () => {
  // The whole point: it reaches the commenter without us knowing their
  // messaging id, which is the only way to reach them at all.
  const messenger = shipped("src/lib/messenger.ts");
  assert.match(messenger, /comment_id/);
  assert.match(messenger, /export async function sendPrivateReplyToComment/);
});

test("the actions are guarded like every other inbox mutation", () => {
  const actions = shipped("src/app/actions/comments.ts");
  assert.match(actions, /requireConversationAccess\(conversationId, "inbox\.reply"\)/);
  // …and must confirm the thread is actually a comment thread, which
  // reachability alone does not prove.
  assert.match(actions, /channel: "comment"/);
});
