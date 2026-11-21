import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decideInstagramComment } from "../src/lib/instagramComments";
import { isOwnPageComment } from "../src/lib/socialComments";

/** Instagram follow gate, part 2 (Sean, 2026-11-21): comments on the business account's posts come in. */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("an Instagram `comments` change becomes a comment filed under its post", () => {
  const decision = decideInstagramComment({
    id: "17900000000000001",
    text: "  GUIDE please  ",
    from: { id: "6200000000000001", username: "a_mum" },
    media: { id: "18000000000000009", media_product_type: "FEED" },
  });
  assert.ok(decision.ok);
  if (!decision.ok) return;
  assert.deepEqual(decision.comment, {
    commentId: "17900000000000001",
    postId: "18000000000000009",
    parentId: null,
    message: "GUIDE please",
    authorId: "6200000000000001",
    authorName: "@a_mum",
    createdAt: null,
    attachmentUrl: null,
    permalink: null,
  });
  // A reply keeps its parent comment.
  const reply = decideInstagramComment({ id: "c2", text: "x", parent_id: "c1", from: { id: "u" }, media: { id: "m" } });
  assert.ok(reply.ok && reply.comment.parentId === "c1");
  // The business account's own reply is recognised as ours.
  const own = decideInstagramComment({ id: "c3", text: "Sent!", from: { id: "IGBIZ" }, media: { id: "m" } });
  assert.ok(own.ok && isOwnPageComment(own.comment, "IGBIZ"));
});

test("nothing to file: no comment id, no post, or no text", () => {
  assert.deepEqual(decideInstagramComment({ text: "hi", media: { id: "m" } }), { ok: false, reason: "no-comment-id" });
  assert.deepEqual(decideInstagramComment({ id: "c", text: "hi" }), { ok: false, reason: "no-post-id" });
  assert.deepEqual(decideInstagramComment({ id: "c", text: "   ", media: { id: "m" } }), { ok: false, reason: "empty" });
  assert.deepEqual(decideInstagramComment(null), { ok: false, reason: "no-comment-id" });
});

test("the webhook files Instagram comments for the workspace holding the account — and only that workspace from its own app", () => {
  const route = code("src/app/api/webhooks/meta/route.ts");
  assert.match(
    route,
    /if \(objectType === "instagram" && change\.field === "comments"\) \{[\s\S]*?withChannelTenantScope\(\s*"instagram",\s*igAccountId,[\s\S]*?recordPostCommentSafely\(decision\.comment, \{ platform: "instagram", pageId: igAccountId \}\);[\s\S]*?reportUnmappedEndpoint\("instagram", igAccountId, 1\),\s*only,\s*\);/,
  );
  // Before the Page `feed` branch, so an Instagram change is never read as a Page one.
  assert.ok(route.indexOf('change.field === "comments"') < route.indexOf('change.field === "feed"'));
});
