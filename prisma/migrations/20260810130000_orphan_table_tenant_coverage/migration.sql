-- =============================================================================
-- TENANT COLUMN COVERAGE — the tables production has and this repository does not
-- =============================================================================
--
-- The 2026-08-10 read-only production audit (PREFLIP-TENANT-AUDIT.md §2) found
-- twenty tables with NO tenantId column at all. A table with no tenant column
-- cannot be enforced: there is nothing for the guard to filter on and nothing
-- for an RLS policy to read, so its rows stay visible to every workspace
-- permanently, no matter what happens to the guard.
--
-- Sorting those twenty against the REPOSITORY rather than against the database
-- moves most of them out of scope, and the reason is worth stating because it is
-- not what the audit assumed:
--
--   * SEVEN ARE PRISMA MODELS AND WERE ALREADY DECLARED GLOBAL — Tenant,
--     Permission, PlatformAdmin, PlatformAdminSession, Passkey, OtpChallenge,
--     PushSubscription all sit in GLOBAL_MODELS (src/lib/tenantGuard.ts). Four
--     of them carried no stated reason; that has been fixed there, not here. No
--     DDL is owed.
--
--   * TWO ARE NOT MODELS AND NEVER WILL BE — `_prisma_migrations` is Prisma's
--     own ledger, and `_ContactToTag` is the join table Prisma generates for the
--     IMPLICIT many-to-many between Contact and Tag. See the note at the foot of
--     this file for why adding a column to the latter would break tagging rather
--     than protect it.
--
--   * TWO ARE THE DEAD PREDECESSORS OF Tenant ITSELF — Organization (1 row) and
--     OrganizationMembership (2). Also at the foot of this file. They do not
--     need a tenantId; they need to stop existing.
--
--   * NINE ARE LEFT, and eight of those get a column here. SecurityRateLimit is
--     the ninth and stays global — see the foot of this file.
--
-- ── WHAT THE EIGHT HAVE IN COMMON ──────────────────────────────────────────
--
-- None of them is a Prisma model. None of them is created by any migration in
-- this repository. `git log -S` across every ref finds no commit that ever
-- declared MarketingJourney*, StockLocation, StockMovement or StockAttachment in
-- a prisma/*.prisma file, and PdfmeTemplate's model was withdrawn after
-- 84d5f3b4. They exist ONLY in the production database.
--
-- That makes them the same drift the RLS gap migration recorded three days ago
-- (20260806180000_rls_enforce_gap, five orphans of exactly this shape) and the
-- same drift the backup rewrite recorded two days before that — src/lib/backup.ts
-- names StockLocation, StockMovement and StockAttachment as three whole tables
-- that were missing from every backup because Prisma did not know about them.
-- Schema reached production without a migration describing it, twice recorded,
-- and this is the third accounting of it.
--
-- Nothing in src/ reads any of the eight. They are covered anyway, on exactly
-- the argument the RLS gap migration made and which has not got weaker: "no code
-- currently reads this table" is a statement about today, the rows are real
-- either way, and a column plus a policy costs nothing while it is cheap. Seven
-- of the eight hold ZERO rows right now, which is the only moment this is a
-- one-line change rather than an ownership investigation.
--
-- ── ADDITIVE AND NULLABLE, DELIBERATELY ────────────────────────────────────
--
-- Every column is added NULLABLE and left nullable. Two of these tables hold
-- rows (StockLocation 2, StockMovement 1) and NOT NULL in the same migration
-- that adds a column to a populated table is how a deploy fails half way. The
-- backfill below claims those three rows for the founding tenant, which is
-- unambiguous today because production has exactly ONE tenant and becomes a
-- forensics exercise the moment it has two.
--
-- TIGHTENING TO NOT NULL IS A FOLLOW-UP, deliberately not done here. It belongs
-- with the enforcement flip, after the two-tenant runtime harness is green, and
-- it must not be attempted while these tables have no Prisma model and no
-- writer: a NOT NULL column on a table nothing stamps is an outage waiting for
-- the first INSERT.
--
-- ── WHY EVERY BLOCK IS GUARDED, AND ON THE TABLE ───────────────────────────
--
-- These eight tables do not exist in a database built from this repository, so
-- CI, previews and every new environment must skip them. 20260806180000 guarded
-- on the COLUMN because its policies read a column that only production had;
-- here the column is what we are CREATING, so the right question is whether the
-- TABLE is there. information_schema returns no row either way.
--
-- Static DDL inside the guard, never EXECUTE'd strings: plpgsql resolves names
-- at execution rather than compile time, so a branch that is not taken may name
-- a table that does not exist — which is the entire case here. Dynamic SQL would
-- also work and would need a NESTED, NAMED dollar-quote tag to carry the policy's
-- own single quotes, which no migration in this repository has ever used.
--
-- (Deliberately described rather than shown: the statement splitter is
-- dollar-quote aware, and tests/sqlStatementSplitter.test.ts counts tags across
-- the whole file — including inside comments, because a splitter cannot tell the
-- difference before it has split. Writing the example out unbalanced the count
-- and failed that test, which is the check working.)
--
-- ── REENTRANT, BECAUSE THE RUNNER OPENS NO TRANSACTION ─────────────────────
--
-- scripts/apply-migrations.mjs executes migrations statement by statement with
-- NO transaction ("No transaction is opened. That matches what db execute did,
-- and it is deliberate"), so a failure part way through leaves the statements
-- before it applied and the migration unrecorded — it then re-runs from the top
-- next deploy. This file survives that: every statement is IF EXISTS /
-- IF NOT EXISTS / DROP-then-CREATE, and the backfill is WHERE "tenantId" IS
-- NULL, so a second run changes nothing. A half-applied migration is not
-- hypothetical in this repository; it took production's login down in July.
--
-- app.bypass_rls is set for the file because the backfill UPDATEs rows on tables
-- this same file puts behind a FORCE'd policy, and on a re-run the policy is
-- already there. The runner pins the whole migration to one session
-- (connection_limit=1) precisely so a SET at the top still applies at the
-- bottom.
-- =============================================================================

SET app.bypass_rls = 'on';

-- -----------------------------------------------------------------------------
-- StockLocation — 2 rows on production
--
-- Stock is shared-catalogue in the OEM/dealer model, but LOCATIONS are
-- dealer-specific: a bay, a yard, a showroom floor belongs to one dealer. This
-- is the shared-stock / walled-customer-data boundary the multi-tenancy design
-- rests on, and it has had no boundary at all. StockUnit, StockReservation and
-- StockEvent — the modelled half of the same domain — have all carried a
-- tenantId since the Phase B slice.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'StockLocation'
  ) THEN
    ALTER TABLE "StockLocation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "StockLocation" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "StockLocation_tenantId_idx" ON "StockLocation"("tenantId");
    ALTER TABLE "StockLocation" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "StockLocation_tenant_isolation" ON "StockLocation";
    CREATE POLICY "StockLocation_tenant_isolation" ON "StockLocation"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "StockLocation" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'StockLocation';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- StockMovement — 1 row on production
--
-- A movement is a dealer's own ledger entry (what left which bay, when, to
-- whom). Shared catalogue, walled movement — same boundary as StockLocation.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'StockMovement'
  ) THEN
    ALTER TABLE "StockMovement" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "StockMovement" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "StockMovement_tenantId_idx" ON "StockMovement"("tenantId");
    ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "StockMovement_tenant_isolation" ON "StockMovement";
    CREATE POLICY "StockMovement_tenant_isolation" ON "StockMovement"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'StockMovement';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- StockAttachment — 0 rows
--
-- Empty, so the backfill is a no-op and the column is free. Included with its
-- two siblings because they are one domain and splitting them would leave the
-- next audit asking why only two of three were done.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'StockAttachment'
  ) THEN
    ALTER TABLE "StockAttachment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "StockAttachment" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "StockAttachment_tenantId_idx" ON "StockAttachment"("tenantId");
    ALTER TABLE "StockAttachment" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "StockAttachment_tenant_isolation" ON "StockAttachment";
    CREATE POLICY "StockAttachment_tenant_isolation" ON "StockAttachment"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "StockAttachment" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'StockAttachment';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- MarketingJourney — 0 rows
--
-- The four MarketingJourney* tables are a marketing-side journey engine that
-- exists only in the production database. The engine this repository actually
-- ships is journeys.prisma's Journey / JourneyVersion / JourneyRun /
-- JourneyEvent / JourneyStepLog, every one of which took its tenantId in
-- 20260726200000_journey_tenant_isolation. These four are the shape that
-- migration was written for, arriving from somewhere else.
--
-- The same audit found the MODELLED journey tables consistently unowned in their
-- DATA — JourneyEvent 10/11, JourneyRun 6/6, JourneyStepLog 6/6 unowned rows.
-- That is a writer bug and a separate fix (audit §4 item 1); this is the
-- structural half of the same module-level miss.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'MarketingJourney'
  ) THEN
    ALTER TABLE "MarketingJourney" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "MarketingJourney" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "MarketingJourney_tenantId_idx" ON "MarketingJourney"("tenantId");
    ALTER TABLE "MarketingJourney" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "MarketingJourney_tenant_isolation" ON "MarketingJourney";
    CREATE POLICY "MarketingJourney_tenant_isolation" ON "MarketingJourney"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "MarketingJourney" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'MarketingJourney';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- MarketingJourneyVersion — 0 rows
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'MarketingJourneyVersion'
  ) THEN
    ALTER TABLE "MarketingJourneyVersion" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "MarketingJourneyVersion" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "MarketingJourneyVersion_tenantId_idx" ON "MarketingJourneyVersion"("tenantId");
    ALTER TABLE "MarketingJourneyVersion" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "MarketingJourneyVersion_tenant_isolation" ON "MarketingJourneyVersion";
    CREATE POLICY "MarketingJourneyVersion_tenant_isolation" ON "MarketingJourneyVersion"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "MarketingJourneyVersion" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'MarketingJourneyVersion';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- MarketingJourneyEnrollment — 0 rows
--
-- An enrolment names a PERSON (a contact or lead) against a journey, so of the
-- four this is the one whose rows would be customer data. Empty today.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'MarketingJourneyEnrollment'
  ) THEN
    ALTER TABLE "MarketingJourneyEnrollment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "MarketingJourneyEnrollment" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "MarketingJourneyEnrollment_tenantId_idx" ON "MarketingJourneyEnrollment"("tenantId");
    ALTER TABLE "MarketingJourneyEnrollment" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "MarketingJourneyEnrollment_tenant_isolation" ON "MarketingJourneyEnrollment";
    CREATE POLICY "MarketingJourneyEnrollment_tenant_isolation" ON "MarketingJourneyEnrollment"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "MarketingJourneyEnrollment" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'MarketingJourneyEnrollment';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- MarketingJourneyStepRun — 0 rows
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'MarketingJourneyStepRun'
  ) THEN
    ALTER TABLE "MarketingJourneyStepRun" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "MarketingJourneyStepRun" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "MarketingJourneyStepRun_tenantId_idx" ON "MarketingJourneyStepRun"("tenantId");
    ALTER TABLE "MarketingJourneyStepRun" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "MarketingJourneyStepRun_tenant_isolation" ON "MarketingJourneyStepRun";
    CREATE POLICY "MarketingJourneyStepRun_tenant_isolation" ON "MarketingJourneyStepRun"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "MarketingJourneyStepRun" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'MarketingJourneyStepRun';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- PdfmeTemplate — 0 rows
--
-- The only one of the eight this repository ever declared: 84d5f3b4 promoted a
-- pdfme prototype to a persisted Document Designer, and the model was later
-- withdrawn when the custom rows/cols/blocks editor replaced it. The table
-- outlived the model, which is the ordinary way this drift happens. A document
-- TEMPLATE is tenant-authored — a dealer's own quote or invoice layout — so if
-- anything ever writes here again, it is tenant data.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'PdfmeTemplate'
  ) THEN
    ALTER TABLE "PdfmeTemplate" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    UPDATE "PdfmeTemplate" SET "tenantId" = 'tenant_denago_cpt'
      WHERE "tenantId" IS NULL
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt');
    CREATE INDEX IF NOT EXISTS "PdfmeTemplate_tenantId_idx" ON "PdfmeTemplate"("tenantId");
    ALTER TABLE "PdfmeTemplate" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "PdfmeTemplate_tenant_isolation" ON "PdfmeTemplate";
    CREATE POLICY "PdfmeTemplate_tenant_isolation" ON "PdfmeTemplate"
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR "tenantId" = current_setting('app.current_tenant', true)
      );
    ALTER TABLE "PdfmeTemplate" FORCE ROW LEVEL SECURITY;
  ELSE
    RAISE NOTICE 'skipping % - not present in this database', 'PdfmeTemplate';
  END IF;
END $$;

RESET app.bypass_rls;

-- =============================================================================
-- THE FOUR THAT DELIBERATELY GET NOTHING
-- =============================================================================
--
-- Recorded here because "we looked at it and decided no" and "we never looked"
-- are indistinguishable a year later, and the whole point of the audit was that
-- being NEITHER scoped nor declared is the only genuinely wrong answer. Each of
-- these is also pinned in tests/tenantSchemaContract.test.ts, which is what
-- stops the decision from being quietly lost — a source file nobody executes is
-- a comment, and a comment is not a contract.
--
-- ── Organization (1 row) / OrganizationMembership (2) ──────────────────────
--
-- These are not conceptual overlap with Tenant. They ARE Tenant, under its
-- previous name, and the audit's "needs reconciling, not merely stamping" is
-- right about the verb and wrong about the difficulty — there is nothing to
-- reconcile because nothing was ever forked.
--
-- Commit d2f38109, "Address #136 review: rename Organization→Tenant", changed
-- `CREATE TABLE "Organization"` to `CREATE TABLE "Tenant"` and
-- `CREATE TABLE "OrganizationMembership"` to `CREATE TABLE "TenantMember"`
-- INSIDE the 20260721130000_tenant_foundation migration, in place. Production
-- had already applied the earlier version, so it kept the tables the original
-- text created and then created the renamed pair alongside them. That is the
-- whole story: 1 Organization row and 1 Tenant row are the same founding dealer
-- written twice, and 2 OrganizationMembership rows are the same memberships.
--
-- Giving Organization a tenantId would be asking which tenant owns the tenant
-- table. The correct action is DROP, and dropping is destructive, out of scope
-- for an additive migration, and worth doing only after someone has diffed the
-- three rows against Tenant/TenantMember to confirm they say what this comment
-- says they say. Left in place, declared, and recommended for deletion in the
-- pull request that carries this file.
--
-- ── SecurityRateLimit (0 rows) ─────────────────────────────────────────────
--
-- GLOBAL, and the only one of the twenty that is deliberately model-less rather
-- than accidentally so: it is created by migration 54_security_rbac_hardening
-- and read exclusively through basePrisma raw SQL in src/lib/rateLimit.ts.
--
-- Its primary key is `scope:HMAC(identifier)` where the identifier is an IP
-- address, an email, a signing token or an API key — LOGIN_POLICY,
-- OTP_SEND_POLICY and SIGNING_POLICY all throttle callers who have not
-- authenticated and therefore have no tenant. Stamping a tenant on it would
-- fail closed on exactly the requests it exists to slow down.
--
-- It would also be a security regression rather than a neutral one: a
-- tenant-scoped limiter is a limiter an attacker can reset by changing tenant
-- context, and login throttling would stop working entirely because there is no
-- session at the time the bucket is read. Global is the correct answer, not the
-- convenient one.
--
-- ── _ContactToTag (0 rows) ─────────────────────────────────────────────────
--
-- The join table Prisma GENERATES for the implicit many-to-many between Contact
-- and Tag. Prisma owns its shape — exactly two columns, "A" and "B" — and a
-- tenantId cannot be added without converting the relation to an explicit
-- ContactTag model, which rewrites every `tags: { connect: … }` call site.
--
-- Adding the column anyway would be actively worse than leaving it. Prisma's
-- implicit-m2m INSERT names only ("A","B"), so every new link would be written
-- with tenantId NULL; a FORCE'd policy would then reject the INSERT under the
-- restricted role and tagging would break at the RLS cutover — a migration that
-- creates an outage in the name of preventing a leak.
--
-- The exposure it leaves is bounded, which is why deferring is defensible: both
-- endpoints are tenant-scoped in their own right, and Tag.tenantId is NOT NULL
-- (20260727220000), so a cross-tenant link cannot be created through the ORM
-- without first reading another tenant's Tag. The residual risk is a raw join
-- that walks the table directly.
--
-- Converting it to an explicit model is a schema refactor with its own blast
-- radius and belongs in its own change. Declared, deferred, and pinned in the
-- contract test so it stays visible.
-- =============================================================================
