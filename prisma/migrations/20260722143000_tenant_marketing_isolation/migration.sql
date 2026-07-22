-- Multi-tenancy Phase B (marketing cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ConsentRecord" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Referral" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "GoogleReview" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Campaign_tenantId_idx" ON "Campaign"("tenantId");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenantId_idx" ON "CampaignRecipient"("tenantId");
CREATE INDEX IF NOT EXISTS "Segment_tenantId_idx" ON "Segment"("tenantId");
CREATE INDEX IF NOT EXISTS "Tag_tenantId_idx" ON "Tag"("tenantId");
CREATE INDEX IF NOT EXISTS "ConsentRecord_tenantId_idx" ON "ConsentRecord"("tenantId");
CREATE INDEX IF NOT EXISTS "EmailTemplate_tenantId_idx" ON "EmailTemplate"("tenantId");
CREATE INDEX IF NOT EXISTS "Survey_tenantId_idx" ON "Survey"("tenantId");
CREATE INDEX IF NOT EXISTS "SurveyResponse_tenantId_idx" ON "SurveyResponse"("tenantId");
CREATE INDEX IF NOT EXISTS "Referral_tenantId_idx" ON "Referral"("tenantId");
CREATE INDEX IF NOT EXISTS "GoogleReview_tenantId_idx" ON "GoogleReview"("tenantId");

UPDATE "Campaign" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CampaignRecipient" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Segment" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Tag" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ConsentRecord" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "EmailTemplate" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Survey" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SurveyResponse" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Referral" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "GoogleReview" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
