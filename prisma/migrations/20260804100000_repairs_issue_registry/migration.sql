-- Repairs issue registry — the table behind /repairs (src/lib/repairs.ts).
--
-- TIMESTAMP-PREFIXED, and it has to be. scripts/apply-migrations.mjs orders by
-- `Number.parseInt(name, 10)`, NOT lexicographically, so every timestamped
-- migration sorts after every numerically-prefixed one and timestamps sort
-- among themselves numerically. This is 20260804100000, later than
-- 20260803120000_journey_wait_for_trigger — the latest migration on main — so
-- it lands at the end of the order rather than in the middle of it.
--
-- No CREATE INDEX CONCURRENTLY anywhere below: Prisma Migrate wraps each
-- migration in a transaction and CONCURRENTLY cannot run inside one. It would
-- not trade a lock for availability, it would fail the migration and ship no
-- index at all. Unlike the journey retention indexes there is no prebuild
-- script to point at either, and there does not need to be: this table is
-- created empty by this migration, so the index builds take no meaningful lock.

CREATE TABLE IF NOT EXISTS "RepairIssue" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "detector"    TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "severity"    TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "fixRoute"    TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"  TIMESTAMP(3),
  "ignoredAt"   TIMESTAMP(3),
  "ignoredById" TEXT,

  CONSTRAINT "RepairIssue_pkey" PRIMARY KEY ("id")
);

-- IDENTITY. One row per problem per tenant, and the entire idempotency
-- guarantee: re-detection upserts onto this constraint, so a detector that runs
-- every fifteen minutes forever still owns exactly one row per problem.
CREATE UNIQUE INDEX IF NOT EXISTS "RepairIssue_tenantId_key_key"
  ON "RepairIssue"("tenantId", "key");

-- The auto-clear sweep, run once per detector per tenant per tick:
--   tenantId = $1 AND detector = $2 AND resolvedAt IS NULL
-- tenantId LEADS for the same reason it does on the journey retention indexes
-- (20260803100000): the sweep runs inside a per-tenant cron slice, so a
-- detector-leading index would make every workspace walk every other
-- workspace's open issues before answering for its own.
CREATE INDEX IF NOT EXISTS "RepairIssue_tenantId_detector_resolvedAt_idx"
  ON "RepairIssue"("tenantId", "detector", "resolvedAt");

-- The page: this tenant's unresolved issues, most recently confirmed first.
CREATE INDEX IF NOT EXISTS "RepairIssue_tenantId_resolvedAt_lastSeenAt_idx"
  ON "RepairIssue"("tenantId", "resolvedAt", "lastSeenAt");

-- RLS. FORCE ROW LEVEL SECURITY has been live since 20260727130000_rls_enforce,
-- and a table added afterwards without a policy is a table with no DB-layer
-- boundary at all — the app guard alone, which is explicitly documented as
-- defence-in-depth rather than the authoritative boundary (src/lib/db.ts).
--
-- No `OR "tenantId" IS NULL` escape hatch: unlike Role/RolePermission there is
-- no such thing as a shared, tenantless repair issue, and the column is NOT
-- NULL precisely so there never can be.
ALTER TABLE "RepairIssue" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RepairIssue_tenant_isolation" ON "RepairIssue";
CREATE POLICY "RepairIssue_tenant_isolation" ON "RepairIssue"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "RepairIssue" FORCE ROW LEVEL SECURITY;
