-- =============================================================================
-- FULL TENANT SCOPE MIGRATION
-- =============================================================================
-- Closes the three remaining "global shared" exceptions that allowed data to
-- leak across tenant boundaries:
--
--   1. User — had no tenantId column at all. Auth queries use basePrisma
--             (bypass_rls='on') so adding tenantId + RLS here does NOT break
--             login; it only means app-context queries are now tenant-isolated.
--
--   2. AppSetting — tenantId column existed but the RLS USING clause allowed
--                   NULL-tenantId rows to be visible to ALL tenants (the
--                   "global/shared" exception). Every setting must belong to
--                   exactly one tenant.
--
--   3. Role / RolePermission — same NULL exception as AppSetting. System roles
--                   (system=true, tenantId=NULL) were intentionally global; they
--                   must now belong to the founding tenant. Per-tenant copies will
--                   be seeded for future tenants during provisioning.
-- =============================================================================

-- =============================================================================
-- 1. User — add tenantId, backfill from TenantMember, add RLS
-- =============================================================================

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
CREATE INDEX IF NOT EXISTS "User_tenantId_idx" ON "User"("tenantId");

-- Backfill: every user belongs to exactly one tenant (one-user-one-tenant policy
-- enforced since migration 20260727120000). Copy from TenantMember.
UPDATE "User" u
SET    "tenantId" = tm."tenantId"
FROM   "TenantMember" tm
WHERE  tm."userId" = u."id"
  AND  u."tenantId" IS NULL;

-- Users with no TenantMember row (orphaned / pre-provisioning) keep tenantId=NULL
-- and become invisible in all tenant contexts — correct fail-closed behaviour.
-- Auth paths use basePrisma (bypass_rls='on') and are unaffected.

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User_tenant_isolation_placeholder" ON "User";
DROP POLICY IF EXISTS "User_tenant_isolation" ON "User";
CREATE POLICY "User_tenant_isolation" ON "User"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- 2. AppSetting — backfill NULL tenantId rows, then remove the NULL exception
-- =============================================================================

-- Assign every currently-global setting to the founding tenant.
-- With a single-global-key PK this is safe while only one tenant exists;
-- per-tenant uniqueness (@@unique([tenantId, key])) is a separate follow-on PR.
UPDATE "AppSetting"
SET    "tenantId" = 'tenant_denago_cpt'
WHERE  "tenantId" IS NULL;

-- Replace the special policy with the standard tenant-isolation policy.
DROP POLICY IF EXISTS "AppSetting_tenant_isolation" ON "AppSetting";
CREATE POLICY "AppSetting_tenant_isolation" ON "AppSetting"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
-- ENABLE / FORCE already set by migration 20260727130000; idempotent to repeat:
ALTER TABLE "AppSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppSetting" FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- 3. Role / RolePermission — assign system roles to founding tenant, standard RLS
-- =============================================================================

-- Move system roles (tenantId IS NULL) to the founding tenant.
-- If a custom role with the same name already exists for the founding tenant,
-- the system role is redundant — delete it (CASCADE removes its RolePermissions).
DELETE FROM "Role"
WHERE "tenantId" IS NULL
  AND "name" IN (
    SELECT "name" FROM "Role" WHERE "tenantId" = 'tenant_denago_cpt'
  );

UPDATE "Role"
SET    "tenantId" = 'tenant_denago_cpt'
WHERE  "tenantId" IS NULL;

-- Sync the denormalized tenantId on RolePermission rows.
UPDATE "RolePermission" rp
SET    "tenantId" = r."tenantId"
FROM   "Role" r
WHERE  rp."roleId" = r."id"
  AND  rp."tenantId" IS NULL;

-- The partial unique index for NULL-tenantId names is now obsolete (no more NULL
-- rows). Drop and replace with a single full-range index that covers all rows.
DROP INDEX IF EXISTS "Role_system_name_key";
-- Role_tenantId_name_key (tenantId IS NOT NULL) already covers the moved rows;
-- update the WHERE clause to remove the restriction — drop and recreate.
DROP INDEX IF EXISTS "Role_tenantId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Role_tenantId_name_key" ON "Role"("tenantId", "name");

-- Replace the NULL-exception policies with standard tenant-isolation policies.
DROP POLICY IF EXISTS "Role_tenant_isolation" ON "Role";
CREATE POLICY "Role_tenant_isolation" ON "Role"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "RolePermission_tenant_isolation" ON "RolePermission";
CREATE POLICY "RolePermission_tenant_isolation" ON "RolePermission"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
