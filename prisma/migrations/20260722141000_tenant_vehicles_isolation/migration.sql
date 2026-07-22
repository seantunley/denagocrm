-- Multi-tenancy Phase B (vehicles cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "WarrantyClaim" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Recall" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "BatteryCheck" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "MileageLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ServiceRecord" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_idx" ON "Vehicle"("tenantId");
CREATE INDEX IF NOT EXISTS "Fleet_tenantId_idx" ON "Fleet"("tenantId");
CREATE INDEX IF NOT EXISTS "WarrantyClaim_tenantId_idx" ON "WarrantyClaim"("tenantId");
CREATE INDEX IF NOT EXISTS "Recall_tenantId_idx" ON "Recall"("tenantId");
CREATE INDEX IF NOT EXISTS "BatteryCheck_tenantId_idx" ON "BatteryCheck"("tenantId");
CREATE INDEX IF NOT EXISTS "MileageLog_tenantId_idx" ON "MileageLog"("tenantId");
CREATE INDEX IF NOT EXISTS "ServiceRecord_tenantId_idx" ON "ServiceRecord"("tenantId");

UPDATE "Vehicle" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Fleet" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "WarrantyClaim" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Recall" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "BatteryCheck" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "MileageLog" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ServiceRecord" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
