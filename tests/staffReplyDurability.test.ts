import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  canonicalJson,
  classifyDeliveryFailure,
  deliveryLabel,
  PERMANENT_FAILURES,
  sendOutcomeMessage,
  staffReplyIdempotencyKey,
  staffReplyMatchesRow,
} from "../src/lib/messageDelivery";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

const staffFn = () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  return outbox.slice(
    outbox.indexOf("export async function enqueueStaffMessage"),
    outbox.indexOf("async function cancelPendingBotOutputTx"),
  );
};

/**
 * A manual reply used to call the provider FIRST and write the CRM record after.
 * A provider success followed by a failed insert left the customer holding a
 * message the CRM had no record of — staff were told it failed, retried, and the
 * customer received it twice.
 *
 * Ordering alone does not fix that. The retry has to be RECOGNISABLE, which is
 * what the client idempotency key is for.
 */

test("the manual WhatsApp reply records and queues before it delivers", () => {
  const action = shipped("src/app/actions/whatsapp.ts");
  // The provider is no longer called from the action at all; the outbox worker
  // owns delivery, with the leases, retries and dead-lettering it already has.
  assert.doesNotMatch(action, /await sendWhatsAppText\(/, "the action must not send before it records");
  assert.match(action, /enqueueStaffMessage\(\{/);
  const enqueueAt = action.indexOf("enqueueStaffMessage({");
  const flushAt = action.indexOf("flushBotOutboxConversation(");
  assert.ok(enqueueAt >= 0 && flushAt > enqueueAt, "delivery must follow the durable record, not precede it");
});

/**
 * THE WHOLE DECISION, OR NONE OF IT.
 *
 * Replying by hand is not just a message — it is a claim of ownership over the
 * conversation. Pausing the bot, withdrawing what the bot was about to say,
 * writing the message down, queueing it and recording the trail used to be five
 * things, four of them awaits AFTER the durable write. Anything that interrupted
 * the request in between left the decision half-made, and the retry could not
 * repair it: the retry recognises the duplicate and stops. The worst outcome —
 * an accepted reply with the bot never paused — sends the customer the person's
 * answer and then the bot's next scripted line.
 */
test("ownership, history and delivery intent are one transaction", () => {
  const fn = staffFn();
  assert.match(fn, /withTenantWrite\(async \(tx, tenantId\)/, "everything shares one transaction");

  const txAt = fn.indexOf("withTenantWrite(async (tx, tenantId)");
  const pauseAt = fn.indexOf("pauseBotSessionTx(tx", txAt);
  const cancelAt = fn.indexOf("cancelPendingBotOutputTx(tx", txAt);
  const outboxAt = fn.indexOf("tx.botFlowOutbox.create", txAt);
  const commAt = fn.indexOf("tx.communication.create", txAt);
  const auditAt = fn.indexOf("logAuditStrict(", txAt);

  assert.ok(pauseAt > txAt, "the bot must be paused INSIDE the transaction, not awaited after it");
  assert.ok(cancelAt > txAt, "the bot's unsent backlog must be withdrawn inside the transaction");
  assert.ok(auditAt > txAt, "the trail must commit with the decision it describes");

  // The outbox row is written FIRST so the unique key rejects a duplicate before
  // any CRM history exists for it. The other order commits a message the CRM
  // claims to have sent and the outbox never queued.
  assert.ok(outboxAt > 0 && commAt > outboxAt, "the delivery intent must be written before the CRM record");

  // Ownership precedes the intent, so a duplicate that finds the intent already
  // present knows the ownership committed too.
  assert.ok(pauseAt < outboxAt && cancelAt < outboxAt, "ownership must be settled before the intent exists");

  // And nothing may re-do those steps outside the transaction, which is where
  // they used to live.
  const action = shipped("src/app/actions/whatsapp.ts");
  assert.doesNotMatch(action, /pauseBotConversation\(/, "the action must not pause separately from the write");
  assert.doesNotMatch(action, /logAudit\(/, "the trail must not be a separate await the request can skip");
});

test("a duplicate reports what became of the message it duplicates", () => {
  const fn = staffFn();
  // The constraint is the real fence; a lost race rolls back rather than
  // returning early with a half-written pair.
  assert.match(fn, /error\.code === "P2002"/);
  // Returning a bare `created: false` left the caller with nothing to report, so
  // it reported success. The duplicate must resolve to the row that already
  // exists so the person is told the truth about it.
  assert.match(fn, /clientIdempotencyKey: input\.clientIdempotencyKey/, "the duplicate must be looked up by its key");
  assert.match(fn, /communicationId: existing\.communicationId \?\? null/);
  assert.match(fn, /outcome: "duplicate"/, "and must say plainly that it is a duplicate, not a fresh send");

  const action = shipped("src/app/actions/whatsapp.ts");
  assert.doesNotMatch(
    action,
    /if \(!queued\.created\)[\s\S]{0,200}return \{ ok: "Sent ✓" \}/,
    "a duplicate must not be congratulated for sending nothing",
  );
});

/**
 * The idempotency key identified the reply BOX. That is wrong in both directions.
 */
test("the idempotency key is bound to the message, not to the reply box", () => {
  const base = {
    compositionId: "c1",
    channel: "whatsapp",
    key: "27820000000",
    actorId: "u1",
    contactId: "ct1",
    leadId: null,
    body: "Yes, we have stock",
  };

  assert.equal(
    staffReplyIdempotencyKey(base),
    staffReplyIdempotencyKey({ ...base }),
    "the same composition resubmitted unchanged must dedupe",
  );

  // The failure mode a box-scoped key produced, and the one that matters most:
  // the send fails ambiguously, the person REVERSES what they were going to say,
  // and the correction is discarded as a duplicate — so the customer receives
  // the opposite of what the salesperson decided.
  assert.notEqual(
    staffReplyIdempotencyKey(base),
    staffReplyIdempotencyKey({ ...base, body: "Sorry, we don't have stock" }),
    "edited text is a different message and must actually send",
  );

  // And the other direction: two deliberately identical replies are two messages.
  assert.notEqual(
    staffReplyIdempotencyKey(base),
    staffReplyIdempotencyKey({ ...base, compositionId: "c2" }),
    "a new composition must be a new message even when the text repeats",
  );

  // A recipient or channel mix-up must never resolve to another conversation's row.
  assert.notEqual(staffReplyIdempotencyKey(base), staffReplyIdempotencyKey({ ...base, key: "27820000001" }));
  assert.notEqual(staffReplyIdempotencyKey(base), staffReplyIdempotencyKey({ ...base, channel: "messenger" }));

  // A reply is also attributed and filed. Without these in the key, a replayed
  // compositionId from a colleague's box, or the same words filed against a
  // different lead, collides with a send it is not — and the caller is told
  // "already sent" about somebody else's message.
  assert.notEqual(staffReplyIdempotencyKey(base), staffReplyIdempotencyKey({ ...base, actorId: "u2" }));
  assert.notEqual(staffReplyIdempotencyKey(base), staffReplyIdempotencyKey({ ...base, contactId: "ct2" }));
  assert.notEqual(staffReplyIdempotencyKey(base), staffReplyIdempotencyKey({ ...base, leadId: "ld1" }));
});

/**
 * A key is a CLAIM about identity. Answering "already sent" without checking it
 * against the row it matched means that if the derivation ever loses a field,
 * the caller is told a different message is theirs and the real one is dropped
 * silently. Verified, that becomes a visible error instead of a lost reply.
 */
test("a key that resolves to a different send is a conflict, not a duplicate", () => {
  const input = {
    channel: "whatsapp",
    key: "27820000000",
    actorId: "u1",
    contactId: "ct1",
    leadId: null,
    payload: { type: "text", text: "hello" },
  };
  const row = { ...input, payload: { type: "text", text: "hello" } };

  assert.equal(staffReplyMatchesRow(input, row), true, "the same send must be recognised as the same send");

  // jsonb does not preserve key order, so an identical payload must still match
  // after a database round trip.
  assert.equal(
    staffReplyMatchesRow(input, { ...row, payload: { text: "hello", type: "text" } }),
    true,
    "key order must not decide whether two payloads are the same",
  );

  assert.equal(staffReplyMatchesRow(input, { ...row, payload: { type: "text", text: "goodbye" } }), false);
  assert.equal(staffReplyMatchesRow(input, { ...row, actorId: "u2" }), false);
  assert.equal(staffReplyMatchesRow(input, { ...row, key: "27820000001" }), false);
  assert.equal(staffReplyMatchesRow(input, { ...row, channel: "messenger" }), false);
  assert.equal(staffReplyMatchesRow(input, { ...row, contactId: "ct2" }), false);
  assert.equal(staffReplyMatchesRow(input, { ...row, leadId: "ld1" }), false);

  // canonicalJson underpins the payload half of that.
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: "1" }));

  const outbox = shipped("src/lib/botOutbox.ts");
  assert.match(outbox, /staffReplyMatchesRow\(/, "the duplicate path must verify, not assume");
  assert.match(outbox, /outcome: "conflict"/, "a mismatch must be reportable as its own outcome");

  const action = shipped("src/app/actions/whatsapp.ts");
  assert.match(action, /queued\.outcome === "conflict"/, "and the action must surface it rather than claim a send");
});

test("the reply box supplies a composition, and the server derives the key", () => {
  const ui = shipped("src/components/InboxReply.tsx");
  assert.match(ui, /name="compositionId"/, "the box must not mint the finished key itself");
  assert.doesNotMatch(ui, /name="clientIdempotencyKey"/);
  // Regenerating on every render, or on failure, would defeat the whole point:
  // the retry after an ambiguous failure must carry the SAME composition.
  assert.match(ui, /if \(state\?\.ok\) setCompositionId\(crypto\.randomUUID\(\)\)/);
  assert.doesNotMatch(ui, /value=\{crypto\.randomUUID\(\)\}/, "the key must not be minted during render");

  const action = shipped("src/app/actions/whatsapp.ts");
  assert.match(action, /staffReplyIdempotencyKey\(\{/, "the server folds the payload into the key");
});

/**
 * A flow composes its messages for a conversation the BOT is still running. Once
 * a person answers, anything still queued was written under an assumption that no
 * longer holds and can land seconds after the human reply, contradicting it.
 * Pausing the session stops NEW output; it does nothing about the backlog, and
 * the backlog is exactly what the customer sees next.
 */
test("human takeover withdraws the bot's unsent output for that conversation", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  const fence = outbox.slice(outbox.indexOf("async function cancelPendingBotOutputTx"));
  assert.match(fence, /origin: "bot"/, "the person's own reply must not be cancelled with the bot's");
  assert.match(fence, /status: \{ in: \["pending", "retry"\] \}/, "only messages that have not left may be withdrawn");
  assert.doesNotMatch(
    fence.slice(0, fence.indexOf("}")),
    /"running"/,
    "a running row belongs to a worker's lease and cannot be decided here",
  );
  assert.match(fence, /status: "cancelled"/);
  assert.match(fence, /failureCode: "superseded_by_human"/);

  // A cancelled row must leave the queue, or it becomes an unclaimable head that
  // silences the conversation for ever — the exact failure dead rows were
  // excluded to prevent.
  assert.match(
    outbox,
    /FINISHED_STATUSES = \["sent", "dead", "cancelled"\]/,
    "cancelled must count as finished for queue ordering",
  );
});

test("the ledger carries the fields a retry policy needs", () => {
  const schema = src("prisma/bot-outbox.prisma");
  assert.match(schema, /clientIdempotencyKey String\?/);
  assert.match(schema, /failureCode String\?/);
  assert.match(schema, /@@unique\(\[tenantId, clientIdempotencyKey\]\)/);

  const migration = src("prisma/migrations/20260809220000_outbound_send_idempotency/migration.sql");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "clientIdempotencyKey"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "BotFlowOutbox_tenantId_clientIdempotencyKey_key"/);
});

/**
 * `failureCode` existed and nothing ever wrote it, which is worse than absent: a
 * schema that promises a retry policy can tell "the number is invalid" from
 * "Meta was briefly down", and a runtime that treats both the same.
 */
test("a failure is classified, stored and acted on", () => {
  assert.equal(classifyDeliveryFailure("Outside the 24-hour reply window — the customer must message you first."), "outside_window");
  assert.equal(classifyDeliveryFailure("Invalid outbox payload"), "invalid_payload");
  assert.equal(classifyDeliveryFailure("Meta page token is not configured (Settings → Integrations)."), "not_configured");
  assert.equal(classifyDeliveryFailure("Send API error 429: too many requests"), "rate_limited");
  assert.equal(classifyDeliveryFailure("socket hang up"), "transient_network");
  // An unfamiliar message must retry. Guessing "permanent" would discard a
  // deliverable customer reply.
  assert.equal(classifyDeliveryFailure("Something nobody has seen before"), "provider_error");

  const outbox = shipped("src/lib/botOutbox.ts");
  const fail = outbox.slice(outbox.indexOf("async function failDelivery"), outbox.indexOf("async function deliverClaimed"));
  assert.match(fail, /failureCode = classifyDeliveryFailure\(lastError\)/);
  // Stored on BOTH outcomes — a row that is going to be retried is exactly where
  // an operator looks to find out why.
  const dead = fail.slice(fail.indexOf('status: "dead"'));
  const retry = fail.slice(fail.indexOf('status: "retry"'));
  assert.match(dead.slice(0, 120), /failureCode/, "the terminal path must record the classification");
  assert.match(retry.slice(0, 120), /failureCode/, "so must the retry path — that is where an operator looks");
  // And acted on, which is the difference between a column and a policy.
  assert.match(fail, /PERMANENT_FAILURES\.has\(failureCode\)/, "a permanent failure must not spend eight attempts");
});

/**
 * The inbox could only ever report the customer's side. A Communication exists
 * from the moment a reply is accepted — before the provider has been called —
 * and the label fell back to "Sent ✓" whenever no receipt had arrived. So a
 * message still queued, a message rejected on every attempt and a message that
 * was delivered all rendered the same three words.
 */
test("an outbound bubble reports delivery, not merely existence", () => {
  const outbound = { direction: "outbound", deliveredAt: null, seenAt: null };

  assert.deepEqual(deliveryLabel(outbound, true, { status: "pending" }), { text: "Sending…", tone: "pending" });
  // A retry is not a message in flight — the provider has already refused it.
  // A retry is not a message in flight — the provider has already refused it.
  assert.deepEqual(deliveryLabel(outbound, true, { status: "retry", attempts: 3 }), { text: "Retrying… (attempt 3)", tone: "failed" });
  assert.deepEqual(deliveryLabel(outbound, true, { status: "sent" }), { text: "Sent ✓", tone: "muted" });

  const dead = deliveryLabel(outbound, true, { status: "dead", failureCode: "invalid_recipient" });
  assert.equal(dead?.tone, "failed");
  assert.match(dead?.text ?? "", /^Not delivered — /, "a rejected message must say so");

  const cancelled = deliveryLabel(outbound, true, { status: "cancelled", failureCode: "superseded_by_human" });
  assert.equal(cancelled?.tone, "failed");
  assert.match(cancelled?.text ?? "", /^Not sent — /);

  // A receipt is proof the message left, whatever the queue believes — a worker
  // can be marked stale after the provider accepted the send.
  assert.deepEqual(
    deliveryLabel({ direction: "outbound", deliveredAt: new Date(), seenAt: null }, true, { status: "retry" }),
    { text: "Delivered ✓✓", tone: "muted" },
  );

  // Messages predating the queue have no outbox row; showing an invented state
  // for them would be worse than showing none.
  assert.deepEqual(deliveryLabel(outbound, true, undefined), { text: "Sent ✓", tone: "muted" });
  assert.equal(deliveryLabel(outbound, false, undefined), null);
  // And the customer's own message is never ours to label.
  assert.equal(deliveryLabel({ direction: "inbound" }, true, { status: "dead" }), null);
});

test("the person who pressed Send is told what actually happened", () => {
  assert.deepEqual(sendOutcomeMessage({ status: "sent" }), { ok: "Sent ✓" });
  // The one that mattered: the action answered "Sent ✓" for a message it had
  // only written down, which ends the person's attention on the conversation.
  assert.ok(sendOutcomeMessage({ status: "pending", attempts: 0 }).ok?.startsWith("Queued"));
  assert.ok(sendOutcomeMessage({ status: "dead", failureCode: "outside_window" }).error);
  assert.ok(sendOutcomeMessage({ status: "cancelled", failureCode: "superseded_by_human" }).error);
  assert.equal(sendOutcomeMessage({ status: "dead" }).ok, undefined);

  const action = shipped("src/app/actions/whatsapp.ts");
  assert.match(action, /sendOutcomeMessage\(state\)/, "the action must report the row's real state");
  assert.match(action, /deliveryStateForMessages\(\[queued\.communicationId\]\)/, "read back after the drain");
});

/**
 * "Queued — sending…" fixed the wording and not the defect.
 *
 * The action drains the conversation BEFORE it reads the state, so by the time
 * it answers, the provider has usually already had its say. A message WhatsApp
 * has just refused — because the 24-hour window is shut, or the credential was
 * revoked — was still being reported in green, as though it were merely in
 * flight. The person moves on, and the customer never hears from them.
 *
 * The attempt count separates the two cases, and it is the only thing that can:
 * zero means nobody has tried yet; anything above zero on a non-terminal row
 * means the provider refused it and the queue is going to keep asking.
 */
test("a message the provider has already refused is not reported as merely queued", () => {
  const refused = sendOutcomeMessage({ status: "retry", attempts: 1, failureCode: "not_configured" });
  assert.equal(refused.ok, undefined, "a rejected message must not come back green");
  assert.match(refused.error ?? "", /not connected/, "and must say what the channel actually objected to");

  // Same for a row still marked running after a failed attempt.
  assert.equal(sendOutcomeMessage({ status: "running", attempts: 2, failureCode: "rate_limited" }).ok, undefined);

  // But a message that genuinely has not been attempted yet is not a failure,
  // and must not be reported as one.
  assert.ok(sendOutcomeMessage({ status: "pending", attempts: 0 }).ok);
  assert.ok(sendOutcomeMessage({ status: "running", attempts: 0 }).ok);
});

/**
 * Meta's 24-hour rule reopens on an INBOUND CUSTOMER MESSAGE, not on the passage
 * of time. A backoff therefore cannot reach it: eight attempts over two hours is
 * a message that was never going to arrive, dressed as one still in flight — and
 * if the window did reopen, an answer composed two hours earlier would go out
 * unannounced into a conversation that has moved on.
 */
test("a closed reply window fails immediately rather than retrying into silence", () => {
  assert.ok(PERMANENT_FAILURES.has("outside_window"), "a timer cannot reopen the 24-hour window");
  assert.ok(PERMANENT_FAILURES.has("invalid_recipient"));
  assert.ok(PERMANENT_FAILURES.has("invalid_payload"));

  // A revoked or mid-rotation credential IS repairable by an operator inside the
  // retry window, and the queue recovering by itself is worth more than failing
  // fast — now that the sender is told immediately either way.
  assert.ok(!PERMANENT_FAILURES.has("not_configured"), "an operator can fix this inside the retry window");
  assert.ok(!PERMANENT_FAILURES.has("rate_limited"));
  assert.ok(!PERMANENT_FAILURES.has("transient_network"));
  assert.ok(!PERMANENT_FAILURES.has("provider_error"), "an unfamiliar failure must stay recoverable");
});

test("a retrying bubble says why, and does not read like a message in flight", () => {
  const outbound = { direction: "outbound", deliveredAt: null, seenAt: null };
  const retrying = deliveryLabel(outbound, true, { status: "retry", attempts: 4, failureCode: "not_configured" });
  assert.equal(retrying?.tone, "failed", "something has already gone wrong; this is not a pending send");
  assert.match(retrying?.text ?? "", /not connected/, "the reason is the actionable part");
  assert.match(retrying?.text ?? "", /attempt 4/, "and by the fourth attempt the count is not noise");
});

test("the outbox row and the timeline row are linked", () => {
  const schema = src("prisma/bot-outbox.prisma");
  assert.match(schema, /communicationId String\?/);
  assert.match(schema, /@@unique\(\[tenantId, communicationId\]\)/, "one delivery record per timeline row");
  assert.match(schema, /origin\s+String\s+@default\("bot"\)/);

  const migration = src("prisma/migrations/20260810110000_staff_reply_delivery_state/migration.sql");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'bot'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "communicationId"/);
  assert.match(migration, /ON DELETE SET NULL/, "deleting a timeline row must not delete the delivery record");

  const fn = staffFn();
  assert.match(fn, /communicationId: communication\.id/, "the link must be written, not merely available");
});

test("a staff reply is logged once, and never as bot output", () => {
  const fn = staffFn();
  // repairCommunicationLog writes a Communication for any SENT row that carries
  // an actorId and no log, stamping it with the bot marker. A staff row has both,
  // so without pre-stamping the log time the worker turns one human reply into
  // two rows — the second attributed to the bot.
  assert.match(fn, /communicationLoggedAt: createdAt/);

  const outbox = shipped("src/lib/botOutbox.ts");
  const repair = outbox.slice(outbox.indexOf("async function repairCommunicationLog"));
  assert.match(repair.slice(0, 200), /if \(row\.communicationLoggedAt\) return false;/,
    "the worker must treat an already-logged row as done");
});
