-- =============================================================================
-- RLS COVERAGE GAP — the tables added after 20260727130000_rls_enforce
-- =============================================================================
--
-- That migration enabled and FORCE'd Row Level Security on the 120 tables that
-- existed when it was written. Production now has 150, and RLS is a per-table
-- setting: a table created afterwards has none, and nothing anywhere said so.
--
-- Found by `npm run check:rls-role` against production, read-only, 2026-08-06.
-- The gap was invisible because the application connects as neondb_owner, which
-- has the BYPASSRLS role attribute — so a table with no policy and a table with
-- a policy behave identically today. They stop behaving identically the moment
-- DATABASE_URL is repointed at the restricted role, and at that point these
-- seven tables would have been the only ones in the database with no tenant
-- boundary at all: exactly the tables an audit would say were protected.
--
-- This is additive and changes NOTHING while the owner role is in use. That is
-- deliberate — it lands ahead of the cutover so that the cutover is a single
-- change to one environment variable, with nothing else in flight.
--
-- Policy shape is copied verbatim from 20260727130000_rls_enforce:
--   bypass_rls='on'  → the trusted system path (basePrisma) sees everything
--   app.current_tenant → set per transaction by src/lib/db.ts
--   FORCE            → the table owner is subject to its own policies too
--
-- tests/rlsPolicyCoverage.test.ts now fails the build when a model with a
-- tenantId has no policy, so this cannot silently recur.
--
-- ── FIVE OF THESE SEVEN ARE ORPHANS ─────────────────────────────────────────
--
-- Only ErrorLog and BackupRun are Prisma models. AutomationApprovalRequest,
-- AutomationOutbox, CampaignEvent, StockTransferRequest and TenantEmailProvider
-- exist in the production database — with tenantId columns and whatever rows
-- they accumulated — but no longer appear in any prisma/*.prisma file. They are
-- left over from features that were renamed or retired: CampaignEvent was
-- superseded by MarketingCampaignEvent, and the automation tables predate
-- 20260802120000_retire_automation_rules.
--
-- Nothing in src/ reads them. They are covered here anyway, because "no code
-- currently reads this table" is a statement about today and the rows are real
-- either way; a policy costs nothing and closes the question.
--
-- It also means the build-time test CANNOT catch tables like these — it reads
-- the Prisma schema, and by definition an orphan is not in it. That is why they
-- are pinned by name in the "gap migration covers exactly what production was
-- missing" test, and why `npm run check:rls-role` runs against the live
-- database rather than the repository.
--
-- Whether these five should be DROPPED is a separate question and a destructive
-- one. It is not answered here.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- AutomationApprovalRequest
-- -----------------------------------------------------------------------------
ALTER TABLE "AutomationApprovalRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AutomationApprovalRequest_tenant_isolation" ON "AutomationApprovalRequest";
CREATE POLICY "AutomationApprovalRequest_tenant_isolation" ON "AutomationApprovalRequest"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AutomationApprovalRequest" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- AutomationOutbox
-- -----------------------------------------------------------------------------
ALTER TABLE "AutomationOutbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AutomationOutbox_tenant_isolation" ON "AutomationOutbox";
CREATE POLICY "AutomationOutbox_tenant_isolation" ON "AutomationOutbox"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AutomationOutbox" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- BackupRun
-- -----------------------------------------------------------------------------
ALTER TABLE "BackupRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BackupRun_tenant_isolation" ON "BackupRun";
CREATE POLICY "BackupRun_tenant_isolation" ON "BackupRun"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BackupRun" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CampaignEvent
-- -----------------------------------------------------------------------------
ALTER TABLE "CampaignEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignEvent_tenant_isolation" ON "CampaignEvent";
CREATE POLICY "CampaignEvent_tenant_isolation" ON "CampaignEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CampaignEvent" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ErrorLog
-- -----------------------------------------------------------------------------
ALTER TABLE "ErrorLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ErrorLog_tenant_isolation" ON "ErrorLog";
CREATE POLICY "ErrorLog_tenant_isolation" ON "ErrorLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ErrorLog" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- StockTransferRequest
-- -----------------------------------------------------------------------------
ALTER TABLE "StockTransferRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockTransferRequest_tenant_isolation" ON "StockTransferRequest";
CREATE POLICY "StockTransferRequest_tenant_isolation" ON "StockTransferRequest"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StockTransferRequest" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TenantEmailProvider
-- -----------------------------------------------------------------------------
ALTER TABLE "TenantEmailProvider" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantEmailProvider_tenant_isolation" ON "TenantEmailProvider";
CREATE POLICY "TenantEmailProvider_tenant_isolation" ON "TenantEmailProvider"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantEmailProvider" FORCE ROW LEVEL SECURITY;


-- =============================================================================
-- DELIBERATELY NOT HERE: TenantMember
-- =============================================================================
-- TenantMember has a tenantId and no policy, and it stays that way.
--
-- The question it answers is "which tenant does this user belong to?", asked on
-- the login path by resolveActingTenant() before any tenant scope exists. A
-- policy of the form `tenantId = current_setting('app.current_tenant')` would
-- make that question circular: you must already know the tenant to find out what
-- the tenant is.
--
-- It is safe today because every caller — auth.ts, tenants.ts, provisioning.ts,
-- platformHealth.ts — reads it through basePrisma, which sets bypass_rls. But
-- "safe because everyone remembers to use basePrisma" is not the same as "safe",
-- and a policy would convert a future mistake from a visible failure into a
-- silent one: addTenantMembership()'s one-user-one-tenant guard queries
-- `NOT: { tenantId }`, and under a tenant-filtered policy that returns nothing,
-- so the guard would pass and the user would be added to a second tenant.
--
-- The right fix is a policy keyed on the USER rather than the tenant, which is a
-- different shape from every policy in this system and belongs in its own change
-- with its own tests. Recorded in tests/rlsPolicyCoverage.test.ts as an explicit,
-- justified exclusion rather than left to be rediscovered.
