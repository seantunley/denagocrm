import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("chatbot-driving provider webhooks claim a stable provider event id", () => {
  const whatsapp = src("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(whatsapp, /claimInboundBotEvent\("whatsapp", String\(message\.id/);

  const meta = src("src/app/api/webhooks/meta/route.ts");
  assert.match(meta, /claimInboundBotEvent\(platform, String\(ev\.message\?\.mid/);

  const telegram = src("src/app/api/webhooks/telegram/route.ts");
  assert.match(telegram, /update_id\?: number/);
  assert.match(telegram, /claimInboundBotEvent\("telegram", String\(update\.update_id/);
});

test("the inbound event fence is tenant-scoped, leased and recoverable", () => {
  const migration = src("prisma/migrations/20260809144000_bot_inbound_event_dedupe/migration.sql");
  assert.match(migration, /UNIQUE INDEX "BotInboundEvent_tenant_channel_provider_key"/);
  assert.match(migration, /\("tenantId", "channel", "providerId"\)/);
  assert.match(migration, /"leaseUntil" TIMESTAMP/);
  assert.match(migration, /"completedAt" TIMESTAMP/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);

  const helper = src("src/lib/botInboundEvent.ts");
  assert.match(helper, /withTenantWrite/);
  assert.match(helper, /ON CONFLICT \("tenantId", "channel", "providerId"\) DO UPDATE/);
  assert.match(helper, /"leaseUntil" IS NULL OR "BotInboundEvent"\."leaseUntil" < NOW\(\)/);
  assert.match(helper, /status: "completed"/);
  assert.match(helper, /status: "retry"/);
});

test("provider routes complete success and release failure instead of permanently claiming first", () => {
  for (const rel of [
    "src/app/api/webhooks/whatsapp/route.ts",
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/telegram/route.ts",
  ]) {
    const code = src(rel);
    assert.match(code, /completeInboundBotEvent\(claim\)/, `${rel} must complete the lease after work`);
    assert.match(code, /retryInboundBotEvent\(claim, error\)/, `${rel} must release failed work for retry`);
  }
});

test("WhatsApp AI context is the latest window, restored to chronological order", () => {
  for (const rel of ["src/lib/bot.ts", "src/lib/flowRun.ts"]) {
    const code = src(rel);
    assert.match(code, /orderBy: \{ occurredAt: "desc" \}/, `${rel} must select newest messages first`);
    assert.match(code, /take: 16/);
    assert.match(code, /\.reverse\(\)\s*\.map\(/, `${rel} must restore chronological order after take`);
  }
});

test("a first-turn AI node receives the customer's first message", () => {
  const code = src("src/lib/flowSession.ts");
  assert.match(code, /if \(input\.text\.trim\(\)\) state\.msgs\.push\(\{ role: "user", content: input\.text \}\)/);
  assert.doesNotMatch(code, /if \(existing && !restart\) state\.msgs\.push/);
});
