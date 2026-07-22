-- Multi-tenancy Phase B (documents cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "LibraryDocument" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "LibraryVersion" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DocTemplateRecord" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DocBuilderTemplate" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DocBuilderVersion" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SignWorkflow" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ApprovalStep" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SignatureField" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CustomDocTemplate" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CustomDocVersion" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DocInstance" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ReusableBlock" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "LibraryDocument_tenantId_idx" ON "LibraryDocument"("tenantId");
CREATE INDEX IF NOT EXISTS "LibraryVersion_tenantId_idx" ON "LibraryVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "DocTemplateRecord_tenantId_idx" ON "DocTemplateRecord"("tenantId");
CREATE INDEX IF NOT EXISTS "DocBuilderTemplate_tenantId_idx" ON "DocBuilderTemplate"("tenantId");
CREATE INDEX IF NOT EXISTS "DocBuilderVersion_tenantId_idx" ON "DocBuilderVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "SignWorkflow_tenantId_idx" ON "SignWorkflow"("tenantId");
CREATE INDEX IF NOT EXISTS "SignatureRequest_tenantId_idx" ON "SignatureRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "ApprovalStep_tenantId_idx" ON "ApprovalStep"("tenantId");
CREATE INDEX IF NOT EXISTS "SignatureRecipient_tenantId_idx" ON "SignatureRecipient"("tenantId");
CREATE INDEX IF NOT EXISTS "SignatureField_tenantId_idx" ON "SignatureField"("tenantId");
CREATE INDEX IF NOT EXISTS "SignatureEvent_tenantId_idx" ON "SignatureEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "CustomDocTemplate_tenantId_idx" ON "CustomDocTemplate"("tenantId");
CREATE INDEX IF NOT EXISTS "CustomDocVersion_tenantId_idx" ON "CustomDocVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "DocInstance_tenantId_idx" ON "DocInstance"("tenantId");
CREATE INDEX IF NOT EXISTS "ReusableBlock_tenantId_idx" ON "ReusableBlock"("tenantId");

UPDATE "LibraryDocument" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "LibraryVersion" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "DocTemplateRecord" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "DocBuilderTemplate" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "DocBuilderVersion" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SignWorkflow" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SignatureRequest" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ApprovalStep" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SignatureRecipient" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SignatureField" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "SignatureEvent" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CustomDocTemplate" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CustomDocVersion" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "DocInstance" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ReusableBlock" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
