-- Multi-tenancy Phase B (automation cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "BotFlow" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "BotSession" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "AutomationLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "BotFlow_tenantId_idx" ON "BotFlow"("tenantId");
CREATE INDEX IF NOT EXISTS "BotSession_tenantId_idx" ON "BotSession"("tenantId");
CREATE INDEX IF NOT EXISTS "AutomationRule_tenantId_idx" ON "AutomationRule"("tenantId");
CREATE INDEX IF NOT EXISTS "AutomationLog_tenantId_idx" ON "AutomationLog"("tenantId");

UPDATE "BotFlow" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "BotSession" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "AutomationRule" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "AutomationLog" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
