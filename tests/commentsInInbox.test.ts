import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Batch 6: public comments were a separate /comments screen beside the inbox.
// They are now the inbox's own Comments tab — still never mixed into the
// conversation tabs — and the old address opens that tab.
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const inbox = src("src/app/(app)/inbox/page.tsx");

test("the inbox has a Comments tab with the moderation list", () => {
  assert.match(inbox, /\{ key: "comments", label: "Comments", count: unreadComments, content: commentsPanel \}/);
  assert.match(inbox, /loadCommentThreads\(\{ archived: false \}\)/);
  assert.match(inbox, /loadCommentThreads\(\{ archived: true \}\)/);
  assert.match(inbox, /initialKey=\{tab === "comments" \? "comments" : "all"\}/);
  // Comments never join the conversation lists: those are built from DMs only.
  assert.doesNotMatch(inbox, /buildInboxThreads\([^)]*omment/);
});

test("the inbox page guards itself with the inbox grant", () => {
  assert.match(inbox, /const user = await requireAnyPermission\("inbox\.view", "inbox\.reply"\);/);
});

test("/comments redirects to the tab and is no longer in the nav", () => {
  const page = src("src/app/(app)/comments/page.tsx");
  assert.match(page, /await requireRoute\("\/comments"\);\s*redirect\("\/inbox\?tab=comments"\);/);
  assert.doesNotMatch(page, /CommentThreadList/);
  assert.doesNotMatch(src("src/components/nav-config.ts"), /href: "\/comments"/);
  assert.doesNotMatch(src("src/app/actions/comments.ts"), /revalidatePath\("\/comments"\)/);
});
