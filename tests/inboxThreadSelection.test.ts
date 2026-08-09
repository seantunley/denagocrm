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

test("the message budget follows the threads chosen, not the whole table", () => {
  const q = shipped("src/lib/inboxQuery.ts");
  assert.match(
    q,
    /take: keys\.length \* MESSAGES_PER_THREAD/,
    "the row budget must be derived from the selected threads so it cannot decide which exist",
  );
  assert.match(q, /OR: messagesForThreads\(keys\)/, "the fetch must be restricted to those threads");
});
