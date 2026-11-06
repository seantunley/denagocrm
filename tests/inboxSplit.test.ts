import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(rel, "utf8");

test("the inbox is three columns: the list stays in view beside the conversation and the deal", () => {
  const split = src("src/components/InboxSplit.tsx");
  assert.match(split, /xl:grid-cols-\[minmax\(16rem,22rem\)_minmax\(0,1fr\)_18rem\]/, "list · conversation · deal");
  assert.match(split, /current && "hidden lg:block"/, "on a phone the list gives way to the conversation…");
  assert.match(split, /All conversations/, "…with a way back");
  assert.match(split, /if \(item\.unread && item\.markRead\) void item\.markRead\(\)/, "opening an unread one marks it read, as the modal did");
  assert.doesNotMatch(src("src/components/SocialThreadList.tsx"), /RowModal/);
});

test("r replies and e archives — once a conversation is open, never while typing", () => {
  const split = src("src/components/InboxSplit.tsx");
  assert.match(split, /if \(!current\) return;/);
  assert.match(split, /if \(target && \(isEditableTarget\(target\) \|\| target\.tagName === "INPUT"\)\) return;/);
  assert.match(split, /if \(event\.key === "r"\) \{\s+const reply = pane\.current\?\.querySelector<HTMLTextAreaElement>\('textarea\[name="text"\]:not\(\[disabled\]\)'\);/);
  assert.match(split, /\} else if \(event\.key === "e"\) \{\s+const archive = pane\.current\?\.querySelector<HTMLFormElement>\("\[data-inbox-archive\] form"\);/);
  assert.match(src("src/components/SocialThreadList.tsx"), /<div data-inbox-archive="">\s+<SaveForm action=\{setThreadArchived\.bind/, "e presses the same Archive the button does");
});

test("the deal rail shows only deals the viewer may open, with stage, value, next action and the next two moves", () => {
  const page = src("src/app/(app)/inbox/page.tsx");
  assert.match(page, /getAccessibleLeadIds\(user\)/);
  assert.match(page, /const dealIds = openable === null \? leadIds : leadIds\.filter\(\(id\) => openable\.has\(id\)\);/);
  assert.match(page, /activities: \{ where: \{ status: "planned", availabilityBlock: false \}, orderBy: \{ dueDate: "asc" \}, take: 1/);
  assert.match(page, /canBookTestDrive: automotiveOn && canManageActivities/, "the /test-drives gate");
  assert.match(page, /hasPermission\(user, "quotes\.create"\)/);
  const rail = src("src/components/SocialThreadList.tsx");
  assert.match(rail, /\{canCreateQuote \? <CreateQuoteButton leadId=\{deal\.id\} \/> : null\}/);
  assert.match(rail, /href=\{`\/test-drives\?book=1&leadId=\$\{deal\.id\}/, "the same pre-filled booking the deal page opens");
  assert.match(src("src/components/quotes/CreateQuoteButton.tsx"), /await createQuoteFromLead\(leadId\)/);
});
