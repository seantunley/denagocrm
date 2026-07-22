-- Multi-tenancy Phase B, slice 2 (Sales cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- add a NULLABLE "tenantId" + index to Quote, Document and PipelineStage, then
-- backfill every existing row to the founding Denago tenant. Nothing reads tenantId
-- yet (no app scoping, no FK, no NOT NULL), so the app runs exactly as before.
--
-- NOTE: Quote."number" stays globally UNIQUE in this PR. The reshaping to
-- @@unique([tenantId, number]) — which drops/re-adds a unique index on a populated
-- table — is a separate, backup-first PR (see MULTITENANCY-SCOPING.md §2.3, §3).
--
-- REPLAY-SAFE: IF NOT EXISTS columns/indexes; backfills scoped to rows still NULL
-- (same pattern as tenant_foundation / the People slice).

ALTER TABLE "Quote"         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Document"      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Quote_tenantId_idx"         ON "Quote"("tenantId");
CREATE INDEX IF NOT EXISTS "Document_tenantId_idx"      ON "Document"("tenantId");
CREATE INDEX IF NOT EXISTS "PipelineStage_tenantId_idx" ON "PipelineStage"("tenantId");

UPDATE "Quote"         SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Document"      SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PipelineStage" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
