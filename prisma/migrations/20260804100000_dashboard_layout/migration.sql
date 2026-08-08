-- Per-user dashboard layouts (prisma/dashboards.prisma).
--
-- TIMESTAMP-PREFIXED, and it has to be. scripts/apply-migrations.mjs orders
-- migrations by `Number.parseInt(name, 10)`, NOT lexicographically, so every
-- timestamped migration runs after every numerically-prefixed one. A `155_`-style
-- name would sort as 155 and run in the middle of the legacy sequence. The prefix
-- is later than 20260803120000 (the latest migration on main at the time of
-- writing) so this lands last.
--
-- Idempotent throughout — apply-migrations.mjs executes the SQL and then records
-- it, so a run that fails partway is re-executed on the next deploy.

CREATE TABLE IF NOT EXISTS "DashboardLayout" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT,
  "userId"    TEXT NOT NULL,
  "cards"     JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

-- The read path is exactly one query — "this user's layout in this tenant" — and
-- tenantId LEADS because every query runs inside a tenant scope, so the predicate
-- the Prisma extension emits is `tenantId = $1 AND userId = $2`. Unique, not just
-- an index: a user has ONE dashboard, and the save path relies on that to decide
-- between an update and an insert.
CREATE UNIQUE INDEX IF NOT EXISTS "DashboardLayout_tenantId_userId_key"
  ON "DashboardLayout"("tenantId", "userId");

-- The unique index above does NOT constrain rows whose tenantId IS NULL, because
-- Postgres treats NULLs as distinct: two rows (NULL, 'user-1') do not collide.
-- Tenant enforcement is dormant today, so EVERY row is written with tenantId NULL
-- and the constraint that is supposed to guarantee "one layout per user" would
-- guarantee nothing at all — two concurrent saves would insert two rows and the
-- dashboard would start reading whichever the planner returned first.
--
-- This partial index closes that window for exactly the NULL case, and stops
-- applying on its own once tenantId is populated. Both indexes are needed: this
-- one until tenancy is enforced, the composite one after.
CREATE UNIQUE INDEX IF NOT EXISTS "DashboardLayout_userId_untenanted_key"
  ON "DashboardLayout"("userId")
  WHERE "tenantId" IS NULL;

-- No CREATE INDEX CONCURRENTLY anywhere above: Prisma Migrate wraps each
-- migration in a transaction and CONCURRENTLY cannot run inside one. The table is
-- brand new and therefore empty, so the index builds are instant and the lock
-- they take is uncontended.

-- FORCE ROW LEVEL SECURITY is live database-wide, so a new table WITHOUT a policy
-- returns zero rows to the application — the failure looks like "every dashboard
-- is empty", not like an error. The policy matches the one every other
-- tenant-owned table carries: the trusted bypass path (basePrisma, backups,
-- cron) sets app.bypass_rls, and a tenant-scoped request matches its own
-- tenantId.
--
-- Deliberately NO `"tenantId" IS NULL` arm, unlike Role/RolePermission. There,
-- NULL means "a seeded row shared by every tenant" and the policy has to admit
-- it. Here NULL only ever means "written while tenancy was dormant", and a
-- dormant request bypasses RLS anyway (db.ts sets app.bypass_rls whenever
-- tenantEnforcing() is false), so the arm would buy nothing while making one
-- tenant's saved layout readable from another the moment enforcement came on.
-- A dashboard layout is owned by exactly one user in exactly one tenant; it is
-- never shared.
ALTER TABLE "DashboardLayout" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DashboardLayout_tenant_isolation" ON "DashboardLayout";
CREATE POLICY "DashboardLayout_tenant_isolation" ON "DashboardLayout"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "DashboardLayout" FORCE ROW LEVEL SECURITY;
