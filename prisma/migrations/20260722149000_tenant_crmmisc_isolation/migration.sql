-- Multi-tenancy Phase B (crmmisc cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "ResearchNote" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SavedView" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Target" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "TimelinePin" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CustomFieldDef" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CustomFieldValue" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "QuoteItem" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "QuoteFee" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "ResearchNote_tenantId_idx" ON "ResearchNote"("tenantId");
CREATE INDEX IF NOT EXISTS "SavedView_tenantId_idx" ON "SavedView"("tenantId");
CREATE INDEX IF NOT EXISTS "Target_tenantId_idx" ON "Target"("tenantId");
CREATE INDEX IF NOT EXISTS "TimelinePin_tenantId_idx" ON "TimelinePin"("tenantId");
CREATE INDEX IF NOT EXISTS "CustomFieldDef_tenantId_idx" ON "CustomFieldDef"("tenantId");
CREATE INDEX IF NOT EXISTS "CustomFieldValue_tenantId_idx" ON "CustomFieldValue"("tenantId");
CREATE INDEX IF NOT EXISTS "QuoteItem_tenantId_idx" ON "QuoteItem"("tenantId");
CREATE INDEX IF NOT EXISTS "QuoteFee_tenantId_idx" ON "QuoteFee"("tenantId");

UPDATE "ResearchNote" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SavedView" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Target" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "TimelinePin" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CustomFieldDef" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CustomFieldValue" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "QuoteItem" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "QuoteFee" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
