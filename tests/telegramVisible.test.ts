import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #29: Telegram conversations were completely invisible. The webhook
// ran the bot and nothing else — no contact, no timeline row, no inbox thread,
// and the bot's own replies were never logged.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("a chat id is stored on the contact, unique within its tenant (additive migration)", () => {
  const schema = src("prisma/schema.prisma");
  assert.match(schema, /telegramChatId String\?/);
  assert.match(schema, /@@unique\(\[tenantId, telegramChatId\]\)/);
  const sql = src("prisma/migrations/20261001120000_contact_telegram_chat/migration.sql");
  assert.match(sql, /ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "Contact_tenantId_telegramChatId_key" ON "Contact"\("tenantId", "telegramChatId"\);/);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE/i, "additive only");
});

test("every inbound message is filed on the contact BEFORE the bot runs", () => {
  const route = src("src/app/api/webhooks/telegram/route.ts");
  const record = route.indexOf("await recordInboundTelegram(");
  const flow = route.indexOf("await runTelegramFlow(chatId, text, undefined, fileUrl)");
  assert.ok(record > 0 && record < flow, "recorded first");
  const lib = src("src/lib/telegramInbound.ts");
  // Tenant-scoped lookup: a chat id is only unique within one bot.
  assert.match(lib, /where: \{ tenantId, telegramChatId: input\.chatId \}/);
  assert.match(lib, /type: "telegram",\s*direction: "inbound",/);
  // Redelivery-safe, like every other inbound channel.
  assert.match(lib, /inboundCommunicationKey\(identity/);
  assert.match(lib, /if \(!key \|\| !isDedupeKeyConflict\(error\)\) throw error;/);
  assert.match(lib, /reopenThreadOnInbound\(contact\.id, null, "telegram"\)/);
});

test("the bot acts on, and logs its replies to, the same contact", () => {
  const flow = src("src/lib/telegram.ts");
  assert.match(flow, /crmActions\("telegram", \{ contactId: contact\?\.id \?\? null, leadId: null \}\)/);
  assert.match(flow, /channel: "telegram", key, messages, flowVersionId, contactId: contact\?\.id \?\? null, actorId: actor\?\.id/);
  assert.match(src("src/lib/botOutbox.ts"), /\["whatsapp", "messenger", "instagram", "telegram"\]\.includes\(row\.channel\)/);
});

test("Telegram is a channel in the inbox, and staff can reply (text)", () => {
  assert.match(src("src/app/(app)/inbox/page.tsx"), /\{ key: "telegram", label: "Telegram",/);
  assert.match(src("src/lib/inboxQuery.ts"), /"telegram"\]/);
  assert.match(src("src/lib/inboxCount.ts"), /"telegram"\]/);
  const reply = src("src/app/actions/messenger.ts");
  assert.match(reply, /: platform === "telegram" \? contact\.telegramChatId/);
  assert.match(reply, /if \(platform === "telegram" && hasFile\) \{/);
});
