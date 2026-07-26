-- Multi-tenancy Phase B (governance cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs. REPLAY-SAFE.
--
-- Role, Permission and RolePermission are intentionally EXCLUDED: the platform
-- shares one permission taxonomy across tenants, so only the ASSIGNMENT of a
-- role to a user (UserRole) is tenant-scoped, not the taxonomy itself.

ALTER TABLE "SalesPipeline" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Team" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "TeamMember" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "UserRole" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ForecastSnapshot" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "SalesPipeline_tenantId_idx" ON "SalesPipeline"("tenantId");
CREATE INDEX IF NOT EXISTS "Team_tenantId_idx" ON "Team"("tenantId");
CREATE INDEX IF NOT EXISTS "TeamMember_tenantId_idx" ON "TeamMember"("tenantId");
CREATE INDEX IF NOT EXISTS "UserRole_tenantId_idx" ON "UserRole"("tenantId");
CREATE INDEX IF NOT EXISTS "ForecastSnapshot_tenantId_idx" ON "ForecastSnapshot"("tenantId");
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_idx" ON "AuditEvent"("tenantId");

UPDATE "SalesPipeline" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Team" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "TeamMember" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "UserRole" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ForecastSnapshot" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
-- AuditEvent is append-only: an AuditEvent_no_update BEFORE-UPDATE trigger
-- (prevent_audit_event_mutation) rejects every UPDATE. Backfilling the new
-- tenantId is a legitimate one-off schema operation, so disable that guard for
-- the single backfill statement and immediately restore it. DISABLE/ENABLE
-- TRIGGER by name and the WHERE "tenantId" IS NULL filter keep this replay-safe.
ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_no_update";
UPDATE "AuditEvent" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_no_update";
