-- Multi-tenancy Phase B (support cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "CustomerCase" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CustomerCaseMessage" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PortalNotification" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PortalProfileChangeRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PortalPreference" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PortalUpload" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PortalAccessGrant" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SupportMailbox" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SupportTag" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CustomerCaseTag" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "CustomerCase_tenantId_idx" ON "CustomerCase"("tenantId");
CREATE INDEX IF NOT EXISTS "CustomerCaseMessage_tenantId_idx" ON "CustomerCaseMessage"("tenantId");
CREATE INDEX IF NOT EXISTS "PortalNotification_tenantId_idx" ON "PortalNotification"("tenantId");
CREATE INDEX IF NOT EXISTS "PortalProfileChangeRequest_tenantId_idx" ON "PortalProfileChangeRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "PortalPreference_tenantId_idx" ON "PortalPreference"("tenantId");
CREATE INDEX IF NOT EXISTS "PortalUpload_tenantId_idx" ON "PortalUpload"("tenantId");
CREATE INDEX IF NOT EXISTS "PortalAccessGrant_tenantId_idx" ON "PortalAccessGrant"("tenantId");
CREATE INDEX IF NOT EXISTS "SupportMailbox_tenantId_idx" ON "SupportMailbox"("tenantId");
CREATE INDEX IF NOT EXISTS "SupportTag_tenantId_idx" ON "SupportTag"("tenantId");
CREATE INDEX IF NOT EXISTS "CustomerCaseTag_tenantId_idx" ON "CustomerCaseTag"("tenantId");

UPDATE "CustomerCase" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CustomerCaseMessage" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PortalNotification" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PortalProfileChangeRequest" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PortalPreference" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PortalUpload" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PortalAccessGrant" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SupportMailbox" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SupportTag" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CustomerCaseTag" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
