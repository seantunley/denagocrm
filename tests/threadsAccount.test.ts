import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { threadsRepliesFrom } from "../src/lib/threadsWebhook";
import { commentAllowsPrivateReply, commentPlatform, commentPlatformPresentation, commentThreadRef } from "../src/lib/socialComments";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";

/**
 * Sean, 2026-11-21: "Please check from that repo how they handle threads and tiktok. Build those into the CRM as new
 * options for social media accounts". Threads: comments on the workspace's posts in the inbox, answered publicly or
 * hidden — Threads has no DMs. The workspace's own app (no third parties).
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const payload = (values: unknown, over: Record<string, unknown> = {}) => ({
  app_id: "APP1", topic: "moderate", target_id: "ACC1", time: 1_763_700_000, subscription_id: "s", values, ...over,
});
const reply = (over: Record<string, unknown> = {}) => ({
  field: "replies",
  value: { id: "R1", username: "a_mum", text: "GUIDE please", root_post: { id: "P1", owner_id: "ACC1", username: "breastfeedingart" }, timestamp: "2026-11-21T15:00:00+0000", ...over },
});

test("a Threads reply becomes a comment filed under its post, for the account that owns the post", () => {
  const [one] = threadsRepliesFrom(payload([reply()]), "APP1");
  assert.equal(one.accountId, "ACC1");
  assert.deepEqual(one.comment, {
    commentId: "R1", postId: "P1", parentId: null, message: "GUIDE please",
    authorId: "a_mum", authorName: "@a_mum", createdAt: Date.parse("2026-11-21T15:00:00+0000"), attachmentUrl: null, permalink: null,
  });
  // A reply to a reply keeps its parent; one straight to the post is top-level.
  assert.equal(threadsRepliesFrom(payload([reply({ replied_to: { id: "R0" } })]), "APP1")[0].comment.parentId, "R0");
  assert.equal(threadsRepliesFrom(payload([reply({ replied_to: { id: "P1" } })]), "APP1")[0].comment.parentId, null);
  // `values` as a single object (Meta's docs) is read the same as an array (the wire).
  assert.equal(threadsRepliesFrom(payload(reply()), "APP1").length, 1);
});

test("nothing is filed from another app, another topic, our own reply, or an incomplete one", () => {
  assert.deepEqual(threadsRepliesFrom(payload([reply()]), "OTHER_APP"), [], "only this workspace's own app");
  assert.deepEqual(threadsRepliesFrom(payload([reply()]), ""), []);
  assert.deepEqual(threadsRepliesFrom(payload([reply()], { topic: "mentions" }), "APP1"), []);
  assert.deepEqual(threadsRepliesFrom(payload([reply({ username: "BreastfeedingArt" })]), "APP1"), [], "our own reply");
  assert.deepEqual(threadsRepliesFrom(payload([reply({ text: "" })]), "APP1"), []);
  assert.deepEqual(threadsRepliesFrom(payload([{ field: "mentions", value: reply().value }]), "APP1"), []);
  assert.deepEqual(threadsRepliesFrom(null, "APP1"), []);
});

test("Threads in the inbox: its icon, public replies and hiding — never a private reply", () => {
  assert.equal(commentPlatform(commentThreadRef("threads", "P1")), "threads");
  assert.deepEqual(commentPlatformPresentation("threads"), { label: "Threads", icon: "/branding/social-threads.svg" });
  assert.equal(commentAllowsPrivateReply("threads"), false);
  assert.equal(commentAllowsPrivateReply("instagram"), true);
  assert.equal(commentAllowsPrivateReply("facebook"), true);
  const actions = code("src/app/actions/comments.ts");
  assert.match(actions, /if \(!commentAllowsPrivateReply\(commentPlatform\(thread\.externalRef\)\)\) refuse\(/, "the server refuses a private reply on Threads");
  assert.match(actions, /const sent = onThreads \? await replyOnThreads\(commentId, body\) : await sendPublicCommentReply\(commentId, body\);/);
  assert.match(actions, /if \(commentPlatform\(thread\.externalRef\) !== "threads"\) refuse\("Hiding is available for Threads comments\."\);/);
  assert.match(actions, /const filed = await prisma\.communication\.findFirst\(\{ where: \{ conversationId: thread\.id, messageId: commentId \}/, "only a comment filed on this thread");
  const list = code("src/components/CommentThreadList.tsx");
  assert.match(list, /canReplyPrivately=\{thread\.privateReplies\}/);
  assert.match(list, /\{!canReplyPrivately \? null : comment\.privateReplied \? \(/);
  assert.match(code("src/lib/commentInbox.ts"), /privateReplies: commentAllowsPrivateReply\(platform\),/);
});

test("the webhook: the workspace's own app — its verify token, its signature, its app id, its account only", () => {
  const route = code("src/app/api/webhooks/threads/route.ts");
  assert.match(route, /if \(!\/\^\[a-z0-9-\]\{1,64\}\$\/\.test\(clean\)\) return null;/);
  assert.match(route, /secretEquals\(params\.get\("hub\.verify_token"\), app\.verifyToken\)/);
  assert.match(route, /crypto\.createHmac\("sha256", app\.secret\)\.update\(raw, "utf8"\)\.digest\("hex"\)/);
  assert.match(route, /crypto\.timingSafeEqual\(/);
  assert.match(route, /threadsRepliesFrom\(body, app\.appId\)/);
  assert.match(route, /if \(\(await resolveChannelTenant\("threads", reply\.accountId\)\) !== app\.tenantId\) \{/, "another workspace's account is never filed here");
  assert.ok(route.indexOf("resolveChannelTenant(") < route.indexOf("recordPostCommentSafely("));
});

test("Connect Threads: this workspace's own app, the account claimed before any token is stored, refreshed before expiry", () => {
  const threads = TENANT_CREDENTIAL_INTEGRATIONS.find((integration) => integration.id === "threads")!;
  assert.deepEqual(threads.fields.filter((f) => f.required !== false).map((f) => f.key), ["THREADS_APP_ID", "THREADS_APP_SECRET", "THREADS_VERIFY_TOKEN"]);
  const lib = code("src/lib/threads.ts");
  assert.ok(lib.indexOf('throw new Error("This Threads account is already connected to another workspace.")') < lib.indexOf("await putTenantCredentialBundle(input.tenantId, {"));
  assert.match(lib, /const REFRESH_WITHIN_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(lib, /grant_type: "th_refresh_token"/);
  // Reply: create, wait for FINISHED, then publish.
  assert.ok(lib.indexOf("/threads`") < lib.indexOf('state === "FINISHED"') && lib.indexOf('state === "FINISHED"') < lib.indexOf("/threads_publish`"));
  const callback = code("src/app/api/integrations/threads/callback/route.ts");
  assert.match(callback, /if \(!activeTenantId \|\| activeTenantId !== pending\.tenantId \|\| url\.searchParams\.get\("state"\) !== pending\.state\)/);
  assert.match(code("src/app/(app)/settings/integrations/page.tsx"), /\{integration\.id === "threads" && <ThreadsConnectBox tenantId=\{tenantId\} connected=\{hasOverride\.THREADS_USER_ID\} notice=\{params\?\.threads \?\? null\} \/>\}/);
});
