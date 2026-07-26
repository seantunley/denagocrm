-- Multi-tenancy Phase B (journey cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each journey table, backfilled to the founding
-- Denago tenant. Nothing reads it yet (enforcement off).
--
-- On production these columns ALREADY exist (they reached prod out-of-band via an
-- unmerged #200 preview deploy) — every statement is IF [NOT] EXISTS so this is a
-- pure no-op there, while giving fresh/CI/disaster-recovery databases the same
-- shape the deployed schema now declares. Journey tables are empty today, so the
-- backfill is a no-op, but it is kept for replay-safety and any future rows.
ALTER TABLE "Journey" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyVersion" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyEvent" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyRun" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyStepLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Journey_tenantId_idx" ON "Journey"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyVersion_tenantId_idx" ON "JourneyVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyEvent_tenantId_idx" ON "JourneyEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyRun_tenantId_idx" ON "JourneyRun"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyStepLog_tenantId_idx" ON "JourneyStepLog"("tenantId");

UPDATE "Journey" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JourneyVersion" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JourneyEvent" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JourneyRun" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JourneyStepLog" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
