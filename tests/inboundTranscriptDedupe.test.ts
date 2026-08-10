import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inboundCommunicationKey, isDedupeKeyConflict } from "../src/lib/inboundMessageKey";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The inbound ledger deliberately RELEASES its lease when webhook work throws, so
 * the provider redelivers. That is correct, and the projection has to tolerate it.
 *
 * It did not: recordInboundWhatsApp / recordInboundDm created a fresh
 * Communication with no provider identity, so every redelivery added the
 * customer's message again. On WhatsApp that is worse than a cosmetic duplicate —
 * the AI's conversation history is rebuilt from Communication, so a replayed row
 * also distorts what the model is answering.
 */

const at = (tenantId: string, channel: string, providerId: string, ledgerEventId?: string) =>
  ({ tenantId, channel, providerId, ledgerEventId });

test("the same provider event always derives the same key", () => {
  assert.equal(
    inboundCommunicationKey(at("t1", "whatsapp", "wamid.ABC")),
    inboundCommunicationKey(at("t1", "whatsapp", " wamid.ABC ")),
    "whitespace must not create a second identity for one message",
  );
  // The ledger row id is globally unique and already encodes tenant+channel+
  // provider, so it wins when present.
  assert.equal(inboundCommunicationKey(at("t1", "whatsapp", "wamid.ABC", "evt_1")), "inbound:evt_1");
});

test("two tenants receiving the SAME provider id do not collide", () => {
  // Communication.dedupeKey is GLOBALLY unique. A key of `messenger:<mid>` would
  // make the transcript's boundary stronger than the ledger's, which is
  // tenantId + channel + providerId — so the second tenant's message would be
  // silently swallowed as a "duplicate".
  const tenantA = inboundCommunicationKey(at("tenant_a", "messenger", "mid123"));
  const tenantB = inboundCommunicationKey(at("tenant_b", "messenger", "mid123"));
  assert.notEqual(tenantA, tenantB, "the same mid on two tenant endpoints is two different messages");

  // …and a redelivery inside tenant A is still the same message.
  assert.equal(inboundCommunicationKey(at("tenant_a", "messenger", "mid123")), tenantA);

  // The same holds via the ledger id, which is unique by construction.
  assert.notEqual(
    inboundCommunicationKey(at("tenant_a", "messenger", "mid123", "evt_a")),
    inboundCommunicationKey(at("tenant_b", "messenger", "mid123", "evt_b")),
  );
});

test("different events, channels and attachments never collide", () => {
  const keys = [
    inboundCommunicationKey(at("t1", "whatsapp", "m1")),
    inboundCommunicationKey(at("t1", "whatsapp", "m2")),
    inboundCommunicationKey(at("t1", "messenger", "m1")),
    inboundCommunicationKey(at("t1", "instagram", "m1")),
    inboundCommunicationKey(at("t1", "instagram", "m1"), 0),
    inboundCommunicationKey(at("t1", "instagram", "m1"), 1),
  ];
  assert.equal(new Set(keys).size, keys.length, `keys collided: ${keys.join(", ")}`);
  // One provider message can produce several attachment rows; each needs its own.
  assert.equal(inboundCommunicationKey(at("t1", "instagram", "m1", "evt_9"), 0), "inbound:evt_9:attachment:0");
});

test("no identity at all yields no key rather than a colliding one", () => {
  // A key of "inbound::whatsapp:" would fold EVERY unidentified message into a
  // single row and lose the transcript. Writing un-keyed risks a duplicate, which
  // is the lesser failure — deliberate, not an oversight.
  assert.equal(inboundCommunicationKey(at("t1", "whatsapp", "")), null);
  assert.equal(inboundCommunicationKey(at("t1", "whatsapp", "   ")), null);
});

/**
 * A fake Communication table with the same two behaviours that matter here: the
 * unique dedupeKey, and the create-time Conversation projection db.ts attaches.
 * createMany has no such hook — which is exactly why the insert must stay create.
 */
function fakeStore() {
  const rows: Array<{ dedupeKey?: string; conversationId: string }> = [];
  const conversations = new Map<string, { messageCount: number; unread: boolean; lastInboundAt: number }>();
  return {
    rows,
    conversations,
    /** Models prisma.communication.create THROUGH the db.ts extension. */
    create(threadKey: string, dedupeKey?: string) {
      if (dedupeKey && rows.some((r) => r.dedupeKey === dedupeKey)) {
        const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["dedupeKey"] } });
        throw conflict;
      }
      // resolveConversationId + create-if-absent
      if (!conversations.has(threadKey)) conversations.set(threadKey, { messageCount: 0, unread: false, lastInboundAt: 0 });
      rows.push({ dedupeKey, conversationId: threadKey });
      // bumpConversation
      const c = conversations.get(threadKey)!;
      c.messageCount += 1;
      c.unread = true;
      c.lastInboundAt += 1;
      return rows[rows.length - 1];
    },
  };
}

/** The projection's own logic, as the two runtimes implement it. */
function project(store: ReturnType<typeof fakeStore>, threadKey: string, dedupeKey: string | null) {
  try {
    store.create(threadKey, dedupeKey ?? undefined);
    return { inserted: true };
  } catch (error) {
    if (!dedupeKey || !isDedupeKeyConflict(error)) throw error;
    return { inserted: false };
  }
}

test("a first delivery projects a Conversation; a replay adds nothing and bumps nothing", () => {
  const store = fakeStore();
  const key = inboundCommunicationKey(at("t1", "whatsapp", "wamid.ABC"));

  const first = project(store, "thread-1", key);
  assert.equal(first.inserted, true);
  assert.equal(store.rows.length, 1);
  assert.equal(store.conversations.size, 1, "the Conversation must exist after the first delivery");
  assert.deepEqual(store.conversations.get("thread-1"), { messageCount: 1, unread: true, lastInboundAt: 1 });

  // The same provider event, redelivered after later work failed.
  const replay = project(store, "thread-1", key);
  assert.equal(replay.inserted, false);
  assert.equal(store.rows.length, 1, "no second transcript row");
  assert.deepEqual(
    store.conversations.get("thread-1"),
    { messageCount: 1, unread: true, lastInboundAt: 1 },
    "and no second bump — the count, unread flag and last-inbound must not move",
  );
});

test("a genuinely different message still projects normally", () => {
  const store = fakeStore();
  project(store, "thread-1", inboundCommunicationKey(at("t1", "whatsapp", "m1")));
  project(store, "thread-1", inboundCommunicationKey(at("t1", "whatsapp", "m2")));
  assert.equal(store.rows.length, 2);
  assert.equal(store.conversations.get("thread-1")?.messageCount, 2);
});

test("a unique violation that is NOT ours is a real error and propagates", () => {
  const other = Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["externalId"] } });
  assert.equal(isDedupeKeyConflict(other), false);
  assert.equal(isDedupeKeyConflict(Object.assign(new Error("x"), { code: "P2003" })), false);
  assert.equal(isDedupeKeyConflict(Object.assign(new Error("x"), { code: "P2002", meta: { target: ["dedupeKey"] } })), true);
});

test("the insert stays create(), because createMany has no Conversation hook", () => {
  // db.ts extends communication.create to resolve/attach the Conversation and bump
  // its counters. There is no createMany hook, so batching would file messages with
  // no Conversation — and assignment, notes, drafts and bot/human ownership all
  // hang off Conversation rows.
  const db = src("src/lib/db.ts");
  const hook = db.slice(db.indexOf("communication: {"), db.indexOf("});", db.indexOf("communication: {")));
  assert.match(hook, /async create\(/, "the Conversation projection hangs off create");
  assert.doesNotMatch(hook, /async createMany\(/, "…and there is no createMany equivalent");
  assert.match(hook, /resolveConversationId/);
  assert.match(hook, /bumpConversation/);
  for (const rel of ["src/lib/whatsapp.ts", "src/lib/messenger.ts"]) {
    const code = src(rel);
    assert.match(code, /prisma\.communication\.create\(/, `${rel}: must use create()`);
    assert.doesNotMatch(code, /communication\.createMany\(/, `${rel}: createMany would skip the Conversation projection`);
    assert.match(code, /isDedupeKeyConflict\(error\)/, `${rel}: the constraint is the replay signal`);
  }
});

test("an attachment redelivery does not persist a second permanent object", () => {
  // persistAttachment writes storage under a fresh random object name every call,
  // so deduping AFTER it left an orphaned blob per redelivery: clean transcript,
  // dirty bucket.
  const code = src("src/lib/messenger.ts");
  const loop = code.slice(code.indexOf("for (const [index, att]"), code.indexOf("reopenThreadOnInbound"));
  const check = loop.indexOf("findUnique({ where: { dedupeKey: attKey }");
  const persist = loop.indexOf("await persistAttachment(att)");
  assert.ok(check !== -1, "the attachment key must be checked");
  assert.ok(check < persist, "and checked BEFORE anything permanent is written");
});

test("a replayed delivery does not notify everyone a second time", () => {
  // The duplicate push is the same defect wearing a different hat, and it is the
  // half a person actually notices.
  // WhatsApp notifies right after the insert, so the condition wraps the push.
  const whatsapp = src("src/lib/whatsapp.ts");
  assert.match(whatsapp, /if \(inserted\) \{[\s\S]{0,200}sendPushToAll/, "only a first delivery may notify");
  // The DM path notifies at the end, so it bails out before reaching it — and the
  // condition is "nothing new was written", NOT "some row was a duplicate". A retry
  // where the text already existed but a missing attachment finally landed HAS
  // produced something the inbox should announce.
  const dm = src("src/lib/messenger.ts");
  const guard = dm.indexOf("if (!insertedAny) return;");
  assert.ok(guard !== -1, "the DM path must bail out only when it wrote nothing");
  assert.ok(dm.indexOf("sendPushToAll", guard) > guard, "and before the notification");
  assert.doesNotMatch(dm, /replayed/, "the old any-duplicate flag must be gone");
  // Both inserts set it, so a newly written attachment counts.
  assert.equal((dm.match(/insertedAny = true;/g) ?? []).length, 2, "text and attachment inserts both count");
});

test("every webhook hands its provider message id to the projection", () => {
  // Without the id the projection cannot key the row, and the ledger's redelivery
  // becomes a duplicate again.
  const whatsapp = src("src/app/api/webhooks/whatsapp/route.ts");
  const calls = whatsapp.match(/recordInboundWhatsApp\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 4, `expected every WhatsApp message type, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /message\.id/, `a WhatsApp projection call has no provider id: ${call}`);
  }
  assert.match(src("src/app/api/webhooks/meta/route.ts"), /recordInboundDm\([^)]*ev\.message\?\.mid/);
});
