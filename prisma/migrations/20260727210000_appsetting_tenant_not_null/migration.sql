-- AppSetting.tenantId → NOT NULL, owned by the founding tenant.
--
-- Rationale: FORCE ROW LEVEL SECURITY is live on AppSetting. Its policy admits a
-- row only when tenantId matches the current tenant (or bypass is set). A row
-- with tenantId IS NULL therefore becomes INVISIBLE to every tenant-scoped query
-- once enforcement is on — historical global settings would silently vanish.
-- The founding tenant (tenant_denago_cpt) IS the platform, so it owns the
-- platform-default settings. Backfill every NULL/legacy-global row to it, then
-- lock the column NOT NULL so no future write can reintroduce an orphan.
--
-- Replay-safe: idempotent DELETE/UPDATE, guarded SET NOT NULL, policy re-created.

-- 1. Drop NULL-tenant rows whose key already exists under the founding tenant, so
--    the backfill can't collide with the (tenantId, key) unique index. The founding
--    row wins (it's the one tenant-scoped code has been writing under enforcement).
DELETE FROM "AppSetting" a
  WHERE a."tenantId" IS NULL
    AND EXISTS (
      SELECT 1 FROM "AppSetting" b
      WHERE b."tenantId" = 'tenant_denago_cpt' AND b."key" = a."key"
    );

-- 2. Adopt every remaining NULL-tenant (legacy global) row into the founding tenant.
UPDATE "AppSetting" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

-- 3. Lock the column. Guard so a re-run (already NOT NULL) is a harmless no-op.
DO $$ BEGIN
  ALTER TABLE "AppSetting" ALTER COLUMN "tenantId" SET NOT NULL;
EXCEPTION WHEN others THEN
  -- already NOT NULL, or a concurrent run set it — nothing to do.
  NULL;
END $$;

-- 4. Re-create the RLS policy without the `tenantId IS NULL = global` escape hatch
--    (migration 20260727130000 added it; there are no NULLs left to admit). A
--    tenant now sees ONLY its own settings; system/off paths use bypass_rls.
ALTER TABLE "AppSetting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AppSetting_tenant_isolation_placeholder" ON "AppSetting";
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
ALTER TABLE "AppSetting" FORCE ROW LEVEL SECURITY;
