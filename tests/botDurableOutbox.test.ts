import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("bot sessions are database-unique by tenant, channel and participant", () => {
  const migration = src("prisma/migrations/20260809152000_bot_session_tenant_identity/migration.sql");
  assert.match(migration, /DROP INDEX IF EXISTS "BotSession_channel_key_key"/);
  assert.match(migration, /\("tenantId", "channel", "key"\)/);

  const store = src("src/lib/botSessionStore.ts");
  assert.match(store, /ON CONFLICT \("tenantId", "channel", "key"\) DO UPDATE/);
  assert.match(store, /where: \{ tenantId, channel, key \}/);
});

test("shared channel transitions commit outbox rows and BotSession in one tenant transaction", () => {
  const code = src("src/lib/flowSession.ts");
  assert.match(code, /withTenantWrite\(async \(tx, tenantId\) => \{/);
  assert.match(code, /await persistMessages\(result\.messages, tx, tenantId(, snapshot\.versionId)?\)/);
  assert.match(code, /await upsertBotSessionTx\(tx, tenantId/);
  assert.match(code, /await deleteBotSessionTx\(tx, tenantId, channel, key\)/);
});

test("WhatsApp commits its durable batch and session position atomically before delivery", () => {
  const code = src("src/lib/flowRun.ts");
  const tx = code.indexOf("await withTenantWrite(async (tx, tenantId)");
  const enqueue = code.indexOf("await enqueueBotMessagesTx(tx, tenantId", tx);
  const session = code.indexOf("await upsertBotSessionTx(tx, tenantId", enqueue);
  const flush = code.indexOf('await flushBotOutboxConversation("whatsapp", digits)', session);
  assert.ok(tx >= 0 && enqueue > tx && session > enqueue && flush > session);
  assert.doesNotMatch(code, /sendWhatsApp(Text|Buttons|List|Image)\(/);
});

test("DM and Telegram adapters write their outbox rows through the shared session transaction", () => {
  for (const rel of ["src/lib/flowDm.ts", "src/lib/telegram.ts"]) {
    const code = src(rel);
    assert.match(code, /async \(messages, tx, tenantId(, flowVersionId)?\) =>/);
    assert.match(code, /enqueueBotMessagesTx\(tx, tenantId/);
    assert.match(code, /flushBotOutboxConversation/);
  }
});

test("outbox preserves order behind retry and terminal dead-letter barriers", () => {
  const schema = src("prisma/bot-outbox.prisma");
  assert.match(schema, /batchId\s+String/);
  assert.match(schema, /sequence\s+Int/);
  assert.match(schema, /@@unique\(\[tenantId, batchId, sequence\]\)/);

  const worker = src("src/lib/botOutbox.ts");
  assert.match(worker, /orderBy: \[\{ createdAt: "asc" \}, \{ sequence: "asc" \}, \{ id: "asc" \}\]/);
  assert.match(worker, /if \(outcome !== "sent"\) break/);
  // The barrier is applied AT the failure — the whole existing backlog dies with
  // the message it was queued behind, so nothing overtakes it.
  assert.match(worker, /Blocked by earlier failed message/);
  // It is not applied for ever. See botTenantScoping.test.ts for why a dead row
  // must stop being a barrier once the backlog has been killed: leaving it as one
  // silenced the bot for that customer permanently, with no reaper.
  assert.match(worker, /status: \{ notIn: \["sent", "dead"\] \}/);
});

test("outbox lease completion is fenced by the claim generation", () => {
  const code = src("src/lib/botOutbox.ts");
  assert.match(code, /attempts: row\.attempts,/);
  assert.match(code, /attempts: row\.attempts \+ 1/);
  assert.match(code, /where: \{ id: row\.id, status: "running", attempts: row\.attempts \}/);
  assert.doesNotMatch(code, /return claimed\.count === 1 \? prisma\.botFlowOutbox\.findUnique/);
});

test("provider success is never resent just because CRM timeline logging failed", () => {
  const code = src("src/lib/botOutbox.ts");
  const markSent = code.indexOf('data: { status: "sent", sentAt: new Date()');
  const repair = code.indexOf("await repairCommunicationLog", markSent);
  assert.ok(markSent >= 0 && repair > markSent, "delivery must be finalized before repairable timeline logging");
  assert.match(code, /dedupeKey = `bot-outbox:\$\{row\.id\}`/);
  assert.match(code, /prisma\.communication\.upsert/);
});

test("failed delivery is leased, retried with backoff and eventually dead-lettered", () => {
  const code = src("src/lib/botOutbox.ts");
  assert.match(code, /status: "running"/);
  assert.match(code, /attempts: \{ increment: 1 \}/);
  assert.match(code, /status: "retry"/);
  assert.match(code, /status: "dead"/);
  assert.match(code, /MAX_ATTEMPTS = 8/);
});

test("bot outbox recovery runs every five minutes", () => {
  const vercel = JSON.parse(src("vercel.json")) as { crons: { path: string; schedule: string }[] };
  assert.ok(vercel.crons.some((cron) => cron.path === "/api/cron/bot-outbox" && cron.schedule === "*/5 * * * *"));
  const route = src("src/app/api/cron/bot-outbox/route.ts");
  assert.match(route, /runCronPerTenant/);
  assert.match(route, /flushBotOutbox\(50, budget\)/);
});
