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
-- ── ONLY ONE OF THESE SEVEN IS A TENANT-SCOPED PRISMA MODEL ─────────────────
--
-- ErrorLog is. The other six are drift, in two flavours, and neither is visible
-- from the repository:
--
--  * FIVE ORPHAN TABLES — AutomationApprovalRequest, AutomationOutbox,
--    CampaignEvent, StockTransferRequest, TenantEmailProvider. They exist in the
--    production database, with tenantId columns and whatever rows they
--    accumulated, and appear in no prisma/*.prisma file. Left over from features
--    renamed or retired: CampaignEvent was superseded by MarketingCampaignEvent,
--    and the automation tables predate 20260802120000_retire_automation_rules.
--
--  * ONE PROD-ONLY COLUMN — BackupRun exists as a Prisma model and has NO
--    tenantId in the schema, but the production table has the column anyway.
--
-- Both are the drift the preview-migrations incident recorded: schema reached
-- the production database without a migration describing it. The audit found
-- these tables because it asks the DATABASE. Nothing that reads the repository
-- can see any of it — which is also why tests/rlsPolicyCoverage.test.ts pins all
-- seven by name, and why `npm run check:rls-role` exists at all.
--
-- Nothing in src/ reads the five orphans. They are covered anyway: "no code
-- currently reads this table" is a statement about today, and the rows are real
-- either way. A policy costs nothing and closes the question.
--
-- Whether the five should be DROPPED, and whether BackupRun's column should be
-- adopted into the schema or removed, are separate questions and destructive
-- ones. Neither is answered here.
--
-- ── WHY EVERY BLOCK IS GUARDED ON THE tenantId COLUMN ───────────────────────
--
-- Two CI failures taught this file what it did not know about its own subject.
--
-- The first version said `ALTER TABLE "AutomationApprovalRequest" ENABLE ROW
-- LEVEL SECURITY` unconditionally: P1014, "the underlying table does not exist"
-- — correct, because in a database built from this repository it does not.
--
-- The second guarded on `pg_tables` and still failed: `column "tenantId" does
-- not exist`. BackupRun's table IS created by a migration; only production has
-- the column. Guarding on the table was asking the wrong question.
--
-- The policy body is `"tenantId" = current_setting(...)`, so the thing it
-- actually depends on is the COLUMN. Asking for that covers the missing column
-- and the missing table in one condition — information_schema.columns returns
-- no row either way. A migration that only works against one particular
-- database is not a migration.
--
-- On production all seven apply. On CI, previews and any new environment, only
-- ErrorLog does and the rest skip with a NOTICE. Either way the file ends in the
-- same state: every table that can carry a tenant policy has one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- AutomationApprovalRequest
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AutomationApprovalRequest' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'AutomationApprovalRequest';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- AutomationOutbox
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AutomationOutbox' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'AutomationOutbox';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- BackupRun
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'BackupRun' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'BackupRun';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- CampaignEvent
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CampaignEvent' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'CampaignEvent';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- ErrorLog
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ErrorLog' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'ErrorLog';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- StockTransferRequest
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'StockTransferRequest' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'StockTransferRequest';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- TenantEmailProvider
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'TenantEmailProvider' AND column_name = 'tenantId'
  ) THEN
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
  ELSE
    RAISE NOTICE 'skipping % - no tenantId column in this database', 'TenantEmailProvider';
  END IF;
END $$;

-- =============================================================================
-- DELIBERATELY NOT HERE: TenantMemberundefined