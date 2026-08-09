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

test("a resubmission under the same key sends nothing further", () => {
  const action = shipped("src/app/actions/whatsapp.ts");
  assert.match(action, /clientIdempotencyKey/);
  assert.match(action, /if \(!queued\.created\)/, "a duplicate must short-circuit before the flush");
  const dupAt = action.indexOf("if (!queued.created)");
  const flushAt = action.indexOf("flushBotOutboxConversation(");
  assert.ok(dupAt >= 0 && dupAt < flushAt, "the duplicate branch must return before any delivery attempt");
});

test("history and delivery intent commit together, intent first", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  const fn = outbox.slice(outbox.indexOf("export async function enqueueStaffMessage"), outbox.indexOf("function asOutMsg"));
  assert.match(fn, /withTenantWrite\(async \(tx, tenantId\)/, "both writes share one transaction");

  // The outbox row is written FIRST so the unique key rejects a duplicate before
  // any CRM history exists for it. The other order commits a message the CRM
  // claims to have sent and the outbox never queued.
  const outboxAt = fn.indexOf("tx.botFlowOutbox.create");
  const commAt = fn.indexOf("tx.communication.create");
  assert.ok(outboxAt >= 0 && commAt > outboxAt, "the delivery intent must be written before the CRM record");

  // The constraint is the real fence; a lost race rolls back rather than
  // returning early with a half-written pair.
  assert.match(fn, /error\.code === "P2002"/);
  assert.match(fn, /return \{ created: false, communicationId: null \}/);
});

test("the send key is stable across retries and changes only on success", () => {
  const ui = shipped("src/components/InboxReply.tsx");
  assert.match(ui, /name="clientIdempotencyKey"/);
  // Regenerating on every render, or on failure, would defeat the whole point:
  // the retry after an ambiguous failure must carry the SAME identity.
  assert.match(ui, /if \(state\?\.ok\) setSendKey\(crypto\.randomUUID\(\)\)/);
  assert.doesNotMatch(ui, /value=\{crypto\.randomUUID\(\)\}/, "the key must not be minted during render");
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

test("a staff reply is logged once, and never as bot output", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  const fn = outbox.slice(outbox.indexOf("export async function enqueueStaffMessage"), outbox.indexOf("function asOutMsg"));
  // repairCommunicationLog writes a Communication for any SENT row that carries
  // an actorId and no log, stamping it with the bot marker. A staff row has both,
  // so without pre-stamping the log time the worker turns one human reply into
  // two rows — the second attributed to the bot.
  assert.match(fn, /communicationLoggedAt: createdAt/);

  const repair = outbox.slice(outbox.indexOf("async function repairCommunicationLog"));
  assert.match(repair.slice(0, 200), /if \(row\.communicationLoggedAt\) return false;/,
    "the worker must treat an already-logged row as done");
});
