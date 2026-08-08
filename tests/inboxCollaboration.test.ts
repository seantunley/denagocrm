import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildInboxThreads, threadCollaborationKey } from "../src/lib/inboxThreads";
import { draftCollision, DRAFT_COLLISION_WINDOW_MS } from "../src/lib/conversationDraft";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Shared inbox Phase 2, rebuilt from PR #17 — which was merged into
 * feature/shared-inbox-phase1 on 2026-07-14 and never reached main.
 *
 * The rebuild is not a replay. Two things changed, and both are tested here
 * rather than described: the join between the inbox's threads and the
 * Conversation rows that carry collaboration, and a per-conversation access
 * guard the original did not have.
 */

const comm = (over: Partial<Parameters<typeof buildInboxThreads>[0][number]> = {}) => ({
  id: "m1",
  type: "whatsapp",
  direction: "inbound",
  body: "Hello",
  occurredAt: new Date("2026-08-08T09:00:00Z"),
  attachmentUrl: null,
  attachmentType: null,
  readAt: null,
  archivedAt: null,
  contactId: null,
  leadId: null,
  contact: null,
  lead: null,
  ...over,
});

/**
 * THE JOIN. The inbox groups Communication rows into threads keyed by a composed
 * string; assignment and notes hang off Conversation, keyed by cuid. Nothing
 * connects the two except both grouping the same way, so if either side's
 * grouping changes this must fail — otherwise every thread silently renders as
 * unassigned with no notes, and nothing looks broken.
 */
test("the collaboration key matches the key buildInboxThreads actually produces", () => {
  for (const channel of ["whatsapp", "messenger", "instagram"]) {
    const [contactThread] = buildInboxThreads([
      comm({ type: channel, contactId: "contact_1", contact: { firstName: "Jane" } }),
    ]);
    assert.equal(
      threadCollaborationKey(contactThread),
      contactThread.key,
      `contact-linked ${channel} thread key must agree`,
    );

    const [leadThread] = buildInboxThreads([
      comm({ type: channel, leadId: "lead_1", lead: { name: "Ken", phone: null } }),
    ]);
    assert.equal(
      threadCollaborationKey(leadThread),
      leadThread.key,
      `lead-linked ${channel} thread key must agree`,
    );
  }
});

test("contact wins over lead, on both sides of the join", () => {
  // buildInboxThreads checks contactId FIRST. A key helper that preferred the
  // lead would file the same conversation under a different key and never match.
  const [thread] = buildInboxThreads([
    comm({ contactId: "contact_1", leadId: "lead_1", contact: { firstName: "Jane" } }),
  ]);
  assert.equal(thread.key, "c:contact_1:whatsapp");
  assert.equal(threadCollaborationKey(thread), "c:contact_1:whatsapp");
  assert.equal(threadCollaborationKey({ contactId: "contact_1", leadId: "lead_1", channel: "whatsapp" }), "c:contact_1:whatsapp");
});

test("a conversation attached to neither a contact nor a lead has no key", () => {
  // buildInboxThreads skips these entirely, so a key for one could never match a
  // rendered thread. Returning null keeps the two consistent.
  assert.equal(threadCollaborationKey({ contactId: null, leadId: null, channel: "whatsapp" }), null);
});

/**
 * THE COLLISION RULE. A shared inbox's characteristic failure is two people
 * answering one customer at once. The window arithmetic is exactly the sort of
 * rule that is wrong quietly, which is why it is a pure function now instead of
 * a comparison buried in a server action.
 */

const NOW = new Date("2026-08-08T12:00:00Z");
const draft = (over: Partial<{ ownerId: string; ownerName: string; updatedAt: Date }> = {}) => ({
  ownerId: "user_other",
  ownerName: "Thandi",
  updatedAt: new Date(NOW.getTime() - 30_000),
  ...over,
});

test("no draft is not a collision", () => {
  assert.equal(draftCollision(null, "user_me", NOW), null);
  assert.equal(draftCollision(undefined, "user_me", NOW), null);
});

test("your OWN draft is never a collision, however recent", () => {
  // Treating it as one would lock a person out of the reply they are writing.
  assert.equal(draftCollision(draft({ ownerId: "user_me", updatedAt: NOW }), "user_me", NOW), null);
});

test("a colleague's FRESH draft is a collision, and names them", () => {
  const collision = draftCollision(draft(), "user_me", NOW);
  assert.ok(collision, "a fresh draft by someone else must collide");
  assert.equal(collision.ownerName, "Thandi");
  // The UI has to say who, and when — "someone is replying" is not actionable.
  assert.equal(collision.updatedAt, draft().updatedAt.toISOString());
});

test("a colleague's STALE draft is not a collision", () => {
  // Somebody who opened a thread and wandered off must not hold it forever, or
  // the inbox jams on abandoned drafts.
  const stale = draft({ updatedAt: new Date(NOW.getTime() - DRAFT_COLLISION_WINDOW_MS - 1) });
  assert.equal(draftCollision(stale, "user_me", NOW), null);
  // Exactly at the window is stale — pinned so the boundary cannot drift silently.
  const exact = draft({ updatedAt: new Date(NOW.getTime() - DRAFT_COLLISION_WINDOW_MS) });
  assert.equal(draftCollision(exact, "user_me", NOW), null);
  const justInside = draft({ updatedAt: new Date(NOW.getTime() - DRAFT_COLLISION_WINDOW_MS + 1) });
  assert.ok(draftCollision(justInside, "user_me", NOW), "one ms inside the window still collides");
});

test("a draft timestamped in the FUTURE counts as fresh, not abandoned", () => {
  // Clock skew between instances gives a negative age. Reading that as "long
  // abandoned" would hand the thread to a second person — the exact failure.
  const skewed = draft({ updatedAt: new Date(NOW.getTime() + 60_000) });
  assert.ok(draftCollision(skewed, "user_me", NOW), "negative age must not read as stale");
});

/**
 * THE ACCESS GUARD. The original checked only that the caller held an inbox
 * permission, then trusted the conversation id it was handed — so a user scoped
 * to their own contacts could assign, note or draft on any thread in the business
 * by naming its id. The list query was always scoped; the actions were not.
 */

test("every exported conversation action guards the specific conversation", () => {
  const code = src("src/app/actions/conversations.ts");
  const exported = [...code.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(exported.length >= 5, `expected the collaboration actions, found ${exported.join(", ")}`);

  for (const name of exported) {
    // Slice from this export to the next one, so each body is checked on its own
    // rather than inheriting the previous action's guard.
    const start = code.indexOf(`export async function ${name}(`);
    const rest = code.slice(start + 1);
    const nextIndex = rest.indexOf("export async function ");
    const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex);
    assert.match(
      body,
      /requireConversationAccess\(conversationId,/,
      `${name} must guard the conversation it acts on, not just the caller's permission`,
    );
  }
});

test("the guard is the sibling shape, not a new rule", () => {
  const permissions = src("src/lib/permissions.ts");
  assert.match(permissions, /export async function canAccessConversation/);
  assert.match(permissions, /export async function requireConversationAccess/);
  // Must agree with the LIST query, or a thread appears and then refuses to act.
  const guard = permissions.slice(
    permissions.indexOf("export async function canAccessConversation"),
    permissions.indexOf("export async function requireConversationAccess"),
  );
  assert.match(guard, /getAccessibleContactIds/, "contact linkage must be considered");
  assert.match(guard, /getAccessibleLeadIds/, "and lead linkage");
  assert.match(guard, /contactIds === null && leadIds === null/, "fully privileged must match accessibleInboxWhere");
});

test("the assignee must be a member of the acting tenant's staff", () => {
  // Otherwise the id travels from the client into assignedToId, which the foreign
  // key satisfies with any User row in the database — including, once a second
  // tenant exists, somebody else's.
  const code = src("src/app/actions/conversations.ts");
  const assign = code.slice(code.indexOf("export async function assignConversation"));
  assert.match(assign, /listTenantStaff\(\)/);
  assert.match(assign, /not a member of your team/i, "and be refused with a reason, not silently");
});

test("discarding a draft cannot clobber a colleague's", () => {
  // The send-success path calls discard unconditionally, so a plain delete would
  // destroy the very draft the collision check exists to protect.
  const code = src("src/app/actions/conversations.ts");
  const discard = code.slice(code.indexOf("export async function discardConversationDraft"));
  assert.match(discard, /deleteMany\(\{\s*where:\s*\{\s*conversationId,\s*ownerId: actor\.id/);
});

/**
 * THE DRAFT UI. The half deliberately left out of the first pass, because a
 * reply box that autosaves and warns about collisions is behaviour, not markup.
 * What can be checked without a browser is the two decisions that matter, and
 * both are about not putting words in somebody's mouth.
 */

test("a colleague's draft body is NEVER restored into your reply box", () => {
  // The whole point of holding drafts server-side is collision detection, not
  // sharing text. Prefilling a colleague's half-written reply into your box
  // invites you to send it as your own — and it would be sent under your name to
  // a customer.
  const code = src("src/components/InboxReply.tsx");
  assert.match(
    code,
    /draft\.ownerId === viewerId \? draft\.body : ""/,
    "restoring must be conditional on OWNING the draft",
  );
});

test("the collision warning renders BEFORE the textarea, not after", () => {
  // Told afterwards, the person has already written the duplicate reply. Order in
  // the JSX is the whole value of the warning.
  const code = src("src/components/InboxReply.tsx");
  const warning = code.indexOf("is already replying to this");
  const textarea = code.indexOf("<textarea");
  assert.ok(warning !== -1, "the warning must exist");
  assert.ok(warning < textarea, `the warning (${warning}) must precede the box (${textarea})`);
});

test("the client decides ownership with the same function the server does", () => {
  // Two hand-written comparisons of the same window is how the client and server
  // come to disagree about who owns a thread.
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /import \{ draftCollision/, "the shared rule must be imported, not re-implemented");
  assert.doesNotMatch(code, /5 \* 60 \* 1000/, "the window must not be restated here");
});

test("a pending autosave is cancelled when the thread closes", () => {
  // The thread lives in a modal that unmounts on close. A late save would write
  // into a conversation the person has already left.
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /useEffect\(\(\) => \(\) => \{ if \(timer\.current\) clearTimeout\(timer\.current\); \}, \[\]\)/);
});

test("a collision stops autosaving rather than retrying", () => {
  // Retrying would overwrite the colleague's draft the moment it went stale,
  // which is the exact outcome the collision check exists to prevent.
  const code = src("src/components/InboxReply.tsx");
  const queue = code.slice(code.indexOf("function queueDraftSave"), code.indexOf("// Once the reply is actually sent"));
  assert.match(queue, /if \(!conversationId \|\| blocked\) return;/, "a blocked box must not queue a save");
  assert.match(queue, /if \(result\.collision\) setBlocked\(result\.collision\)/);
});

test("draft persistence is opt-in, so /messages keeps working unchanged", () => {
  // The same reply box renders in the Messages PWA, which resolves no
  // conversation. Without the guard it would autosave against `undefined`.
  const code = src("src/components/InboxReply.tsx");
  assert.match(code, /const drafting = Boolean\(conversationId\)/);
  assert.match(code, /onChange=\{drafting \? queueDraftSave : undefined\}/);
});
