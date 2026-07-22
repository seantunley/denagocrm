-- Multi-tenancy Phase B, slice 1 (People cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- add a NULLABLE "tenantId" + index to Contact, Lead, Activity and Communication,
-- then backfill every existing row to the founding Denago tenant. Nothing reads
-- tenantId yet (no app scoping, no FK, no NOT NULL), so the app runs exactly as
-- before. A later, separate PR flips NOT NULL + adds the FK to "Tenant" once the
-- backfill is confirmed on prod (that step touches a populated table's constraints,
-- so it is isolated and backup-first — see MULTITENANCY-SCOPING.md §2.3, §3 Phase B).
--
-- REPLAY-SAFE: every column/index uses IF NOT EXISTS and the backfills are scoped to
-- rows still NULL, so re-running is harmless (matches the tenant_foundation pattern).

ALTER TABLE "Contact"       ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Lead"          ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Activity"      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Contact_tenantId_idx"       ON "Contact"("tenantId");
CREATE INDEX IF NOT EXISTS "Lead_tenantId_idx"          ON "Lead"("tenantId");
CREATE INDEX IF NOT EXISTS "Activity_tenantId_idx"      ON "Activity"("tenantId");
CREATE INDEX IF NOT EXISTS "Communication_tenantId_idx" ON "Communication"("tenantId");

-- Backfill existing rows to the founding tenant seeded by 20260721130000_tenant_foundation.
UPDATE "Contact"       SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Lead"          SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Activity"      SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Communication" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
