-- Multi-tenancy Phase B (custom roles). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on Role and RolePermission, backfilled to the
-- founding Denago tenant. Nothing reads it yet (no FK/NOT NULL/scoping;
-- tenantEnforcing() stays false). REPLAY-SAFE — every statement uses
-- IF [NOT] EXISTS / DROP ... IF EXISTS so the whole file can be re-run.
--
-- Product decision (supersedes the "Role/RolePermission are GLOBAL" note in
-- 20260725160000_tenant_governance_isolation): SYSTEM/seeded roles
-- ("system" = true) remain a single shared, global taxonomy (tenantId stays
-- NULL, forever). But a tenant admin can already author their OWN custom
-- roles via createRole()/updateRolePermissions() — those must become
-- tenant-owned, not silently shared/editable by every other tenant. Role.
-- tenantId is the signal: NULL = system/global, non-null = one tenant's own
-- custom role. RolePermission.tenantId is a denormalized copy of its Role's
-- tenantId (same convention as CampaignRecipient carrying its parent
-- Campaign's tenantId — see marketingCampaignQueue.ts), so raw-SQL reads can
-- filter directly without a join. Permission (the capability catalog itself)
-- is unaffected and stays global.

ALTER TABLE "Role" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "RolePermission" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Backfill: existing custom (non-system) roles become the founding tenant's.
-- System roles stay NULL/global — never backfilled.
UPDATE "Role" SET "tenantId" = 'tenant_denago_cpt' WHERE "system" = false AND "tenantId" IS NULL;

-- Backfill RolePermission's denormalized copy from its Role. Harmless that
-- this leaves/sets NULL for system roles' permission rows — that's correct.
UPDATE "RolePermission" rp
SET "tenantId" = r."tenantId"
FROM "Role" r
WHERE rp."roleId" = r."id" AND rp."tenantId" IS NULL;

CREATE INDEX IF NOT EXISTS "Role_tenantId_idx" ON "Role"("tenantId");
CREATE INDEX IF NOT EXISTS "RolePermission_tenantId_idx" ON "RolePermission"("tenantId");

-- Replace the old GLOBAL unique on Role.name (Prisma's default naming for the
-- single-field @unique this schema used to declare: a unique INDEX, not a
-- table CONSTRAINT — confirmed against the table's origin in migration
-- 52_pipelines_forecasting_rbac_audit, "CREATE UNIQUE INDEX ... Role_name_key").
-- Standard Prisma @@unique([tenantId, name]) cannot replace it: Postgres
-- treats NULL as DISTINCT from NULL in a multi-column unique index, so it
-- would NOT stop two system roles (both tenantId IS NULL) from sharing a
-- name. Two separate PARTIAL unique indexes are required instead:
--   - system role names unique among themselves (tenantId IS NULL)
--   - tenant-authored role names unique per tenant (tenantId IS NOT NULL)
DROP INDEX IF EXISTS "Role_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Role_system_name_key" ON "Role"("name") WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Role_tenantId_name_key" ON "Role"("tenantId", "name") WHERE "tenantId" IS NOT NULL;
