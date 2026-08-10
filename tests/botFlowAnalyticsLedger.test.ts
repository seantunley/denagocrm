import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("flow analytics has a purpose-built tenant/RLS ledger", () => {
  const migration = src("prisma/migrations/20260809154500_bot_flow_events/migration.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "BotFlowEvent"/);
  assert.match(migration, /"tenantId" TEXT NOT NULL/);
  assert.match(migration, /"flowVersionId" TEXT/);
  assert.match(migration, /"nodeId" TEXT/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /"tenantId" = current_setting\('app\.current_tenant', true\)/);
});

test("ledger indexes the reporting and conversation access paths", () => {
  const migration = src("prisma/migrations/20260809154500_bot_flow_events/migration.sql");
  assert.match(migration, /BotFlowEvent_tenant_flow_version_idx/);
  assert.match(migration, /BotFlowEvent_tenant_node_event_idx/);
  assert.match(migration, /BotFlowEvent_tenant_conversation_idx/);
});

test("analytics metadata is bounded and never becomes a second transcript store", () => {
  const code = src("src/lib/botFlowAnalytics.ts");
  assert.match(code, /encoded\.length <= 4000/);
  assert.match(code, /Analytics metadata is diagnostic context, never a transcript\/content store/);
  assert.doesNotMatch(code, /body:|transcript:|messages:/);
});

test("trusted aggregation always pairs bypassed reads with an explicit tenant predicate", () => {
  const code = src("src/lib/botFlowAnalytics.ts");
  const query = code.slice(code.indexOf("export async function getBotFlowVersionAnalytics"));
  assert.match(query, /const tenantId = writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  assert.ok((query.match(/WHERE "tenantId" = \$\{tenantId\}/g) ?? []).length >= 2);
  assert.match(query, /"flowVersionId" IN \(\$\{Prisma\.join\(flowVersionIds\)\}\)/);
});

test("runtime integrations can record events inside the same tenant transaction", () => {
  const code = src("src/lib/botFlowAnalytics.ts");
  assert.match(code, /export async function recordBotFlowEventsTx/);
  assert.match(code, /tx: TenantWriteTx/);
  assert.match(code, /INSERT INTO "BotFlowEvent"/);
});

test("published version deletion keeps historical event rows", () => {
  const migration = src("prisma/migrations/20260809154500_bot_flow_events/migration.sql");
  assert.match(migration, /FOREIGN KEY \("flowVersionId"\) REFERENCES "BotFlowVersion"\("id"\) ON DELETE SET NULL/);
  assert.doesNotMatch(migration, /BotFlowEvent_flowVersionId_fkey[\s\S]*ON DELETE CASCADE/);
});
