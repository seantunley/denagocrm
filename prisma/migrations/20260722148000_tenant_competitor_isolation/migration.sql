-- Multi-tenancy Phase B (competitor cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "Competitor" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CompetitorSource" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CompetitorSnapshot" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CompetitorChange" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CompetitorBrief" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Competitor_tenantId_idx" ON "Competitor"("tenantId");
CREATE INDEX IF NOT EXISTS "CompetitorSource_tenantId_idx" ON "CompetitorSource"("tenantId");
CREATE INDEX IF NOT EXISTS "CompetitorSnapshot_tenantId_idx" ON "CompetitorSnapshot"("tenantId");
CREATE INDEX IF NOT EXISTS "CompetitorChange_tenantId_idx" ON "CompetitorChange"("tenantId");
CREATE INDEX IF NOT EXISTS "CompetitorBrief_tenantId_idx" ON "CompetitorBrief"("tenantId");

UPDATE "Competitor" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CompetitorSource" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CompetitorSnapshot" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CompetitorChange" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CompetitorBrief" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
