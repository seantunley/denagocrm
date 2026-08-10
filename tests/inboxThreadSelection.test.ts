import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * Which conversations exist must not be decided by how talkative one of them is.
 *
 * Both inbox surfaces used to take the newest 400 Communication rows and group
 * them afterwards, so thread SELECTION competed with message VOLUME: a single
 * busy conversation could consume the budget and push other active or unread
 * threads out of the dataset — out of the queue and out of the unread count,
 * silently. The inbox just looked emptier than it was.
 *
 * WHAT THESE TESTS CAN AND CANNOT SHOW. Reading the source can establish that no
 * global row slice remains and that the per-thread limit is expressed as one.
 * It cannot establish that a quiet conversation actually survives beside a loud
 * one — "select threads, then load their messages under one shared budget" and
 * "…under a budget per thread" are the same shape and only the second is
 * correct. That property is proved against a real database, on a dataset with a
 * genuinely dominant conversation, in scripts/test-inbox-thread-selection.ts,
 * which CI runs in the integration lane. These tests guard the shapes that
 * cannot regress silently; that one guards the behaviour.
 */

for (const page of ["src/app/(app)/inbox/page.tsx", "src/app/messages/page.tsx"]) {
  test(`${page}: conversations are not drawn from a global message slice`, () => {
    const code = shipped(page);
    assert.doesNotMatch(
      code,
      /communication\.findMany\(\{[\s\S]{0,400}?take: 400/,
      "a fixed global row budget decides which threads survive, not which are recent",
    );
    assert.match(code, /loadInboxComms\(/, "both surfaces must select threads before messages");
  });
}

test("threads are selected by their own recency, before any message is loaded", () => {
  const q = shipped("src/lib/inboxQuery.ts");
  // Selection is an aggregate over threads, ordered by when each was last active.
  assert.match(q, /groupBy\(\{/);
  assert.match(q, /_max: \{ occurredAt: true \}/);
  assert.match(q, /orderBy: \{ _max: \{ occurredAt: "desc" \} \}/);
  // and it happens first.
  const select = q.indexOf("recentThreadKeys");
  const load = q.indexOf("communication.findMany");
  assert.ok(select >= 0 && load > select, "message loading must follow thread selection");
});

test("a thread is counted once, under contact when it has one", () => {
  const q = shipped("src/lib/inboxQuery.ts");
  // The lead pass must exclude rows that already carry a contact, or one
  // conversation appears under both keys and the page shows it twice.
  const leadPass = q.slice(q.indexOf('by: ["leadId", "type"]'));
  assert.match(leadPass.slice(0, 300), /contactId: null/, "lead-keyed threads must exclude contact-keyed rows");
});

/**
 * Selecting the threads first is only half the fix.
 *
 * `take: keys.length * MESSAGES_PER_THREAD` is a budget derived from the
 * selection and still handed out in GLOBAL recency order, so a conversation
 * carrying more recent messages than the whole page budget consumes all of it and
 * every other selected thread arrives with zero rows. buildInboxThreads renders a
 * thread from its messages, so those threads vanish from the queue again — the
 * original defect, one step later and harder to see.
 */
test("the per-thread message budget is applied per thread, not across all of them", () => {
  const q = shipped("src/lib/inboxQuery.ts");

  assert.doesNotMatch(
    q,
    /take:\s*keys\.length\s*\*/,
    "a budget multiplied by the thread count is still one shared pool, drained in global order",
  );

  // A limit that applies within each conversation is a window function over a
  // partition; nothing weaker expresses "the newest N of EACH".
  assert.match(q, /ROW_NUMBER\(\) OVER \(/, "the per-thread limit must rank within each thread");
  assert.match(
    q,
    /PARTITION BY kind, key_id, chan/,
    "the partition must be the thread identity: contact-or-lead plus channel",
  );
  assert.match(
    q,
    /ORDER BY occurred_at DESC, id DESC/,
    "each thread's slice must be its NEWEST messages, with a deterministic tiebreak",
  );
  assert.match(q, /WHERE rn <= \$4/, "the rank must actually bound the rows returned");
});

test("the ranked ids are read back through the guarded client", () => {
  const q = shipped("src/lib/inboxQuery.ts");
  // The raw step ranks and returns ids; the rows themselves must come back
  // through Prisma so the include, the soft-delete filter and the caller's
  // scopeWhere all still apply to what is actually rendered.
  const load = q.slice(q.indexOf("export async function loadInboxComms"));
  assert.match(load, /prisma\.communication\.findMany\(\{/, "rows must be hydrated through the guarded client");
  assert.match(load, /id: \{ in: ids \}/, "hydration must be restricted to the ranked ids");
  assert.match(load, /\.\.\.scopeWhere/, "the caller's record scope must still apply to the rows returned");
  assert.match(load, /OR: messagesForThreads\(keys\)/, "the fetch must be restricted to the selected threads");
});

/**
 * The sidebar badge asked the same question through the same broken slice, and it
 * is the worse of the two places to be wrong: the inbox looking short is visible,
 * a badge reading 0 says "you are caught up" about conversations nobody opened.
 */
test("the unread badge does not count through a global row slice", () => {
  const count = shipped("src/lib/inboxCount.ts");
  assert.doesNotMatch(count, /take:\s*\d+/, "a row cap makes the badge a function of message volume");
  assert.doesNotMatch(
    count,
    /orderBy: \{ occurredAt: "desc" \}/,
    "ordering rows then taking the first per thread is the slice this replaces",
  );
});

test("the unread badge identifies the newest message of each thread independently", () => {
  const count = shipped("src/lib/inboxCount.ts");
  assert.match(count, /groupBy\(\{/, "the newest message per thread must come from an aggregate");
  assert.match(count, /_max: \{ occurredAt: true \}/);
  assert.match(
    count,
    /by: \["contactId", "type"\]/,
    "threads are keyed by contact and channel, as the inbox keys them",
  );
  assert.match(count, /by: \["leadId", "type"\]/, "and by lead when there is no contact");

  // "Newest is an unopened inbound" is expressed as two aggregates agreeing:
  // when the thread was last active at all, and when it was last active with an
  // unopened inbound message.
  assert.match(count, /direction: "inbound", readAt: null/, "the unread aggregate must be inbound and unopened");
  assert.match(
    count,
    /lastActivity\.get\(key\) === at/,
    "a thread counts only when its newest message IS the unopened inbound one",
  );
});
