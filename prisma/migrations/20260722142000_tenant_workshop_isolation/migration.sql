-- Multi-tenancy Phase B (workshop cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "JobCard" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ServicePackage" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ServicePackageItem" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JobCardInspectionItem" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JobCardApproval" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "WorkshopBay" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JobCardTimeEntry" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JobCardItem" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ServiceReminderLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "JobCard_tenantId_idx" ON "JobCard"("tenantId");
CREATE INDEX IF NOT EXISTS "ServicePackage_tenantId_idx" ON "ServicePackage"("tenantId");
CREATE INDEX IF NOT EXISTS "ServicePackageItem_tenantId_idx" ON "ServicePackageItem"("tenantId");
CREATE INDEX IF NOT EXISTS "JobCardInspectionItem_tenantId_idx" ON "JobCardInspectionItem"("tenantId");
CREATE INDEX IF NOT EXISTS "JobCardApproval_tenantId_idx" ON "JobCardApproval"("tenantId");
CREATE INDEX IF NOT EXISTS "WorkshopBay_tenantId_idx" ON "WorkshopBay"("tenantId");
CREATE INDEX IF NOT EXISTS "JobCardTimeEntry_tenantId_idx" ON "JobCardTimeEntry"("tenantId");
CREATE INDEX IF NOT EXISTS "JobCardItem_tenantId_idx" ON "JobCardItem"("tenantId");
CREATE INDEX IF NOT EXISTS "ServiceReminderLog_tenantId_idx" ON "ServiceReminderLog"("tenantId");

UPDATE "JobCard" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ServicePackage" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ServicePackageItem" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JobCardInspectionItem" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JobCardApproval" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "WorkshopBay" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JobCardTimeEntry" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "JobCardItem" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ServiceReminderLog" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
