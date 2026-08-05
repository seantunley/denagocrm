-- Long-term reporting statistics: pre-aggregated buckets + the rollup cursor.
-- See prisma/statistics.prisma and src/lib/statistics.ts.
--
-- TIMESTAMP-PREFIXED, and it has to be. scripts/apply-migrations.mjs orders by
-- `Number.parseInt(name, 10)`, NOT lexicographically, so every timestamped
-- migration runs after every numerically-prefixed one. This migration indexes
-- "Lead" and "JobCard", which are created in 0_init — so a numeric prefix would
-- be fine for those — but the tenant columns it relies on are added by the
-- timestamped tenant-isolation migrations, and a `81_`-style name would sort as
-- 81 and run long before them. Anything touching a tenant column must be
-- timestamped.
--
-- ⚠ THE SOURCE-TABLE INDEXES AT THE BOTTOM BLOCK WRITES WHILE THEY BUILD.
--    READ scripts/prebuild-statistics-indexes.sql BEFORE DEPLOYING TO A BUSY
--    DATABASE. "Lead" is the busiest table in the CRM.

-- -----------------------------------------------------------------------------
-- StatisticBucket — one pre-aggregated measurement.
-- -----------------------------------------------------------------------------
-- `id` is DERIVED from (tenantId, metric, period, bucketStart, dimension) by
-- statisticBucketId() rather than generated, and that is the idempotency
-- primitive: two rollup runs computing the same bucket compute the same id, so
-- they address the same row instead of inserting two.
--
-- A UNIQUE constraint on those five columns cannot do that job here. `tenantId`
-- is nullable — it is null in enforcement-dormant mode, which is every
-- deployment today — and Postgres treats NULLs in a unique index as distinct,
-- so the constraint would permit unlimited duplicates in exactly the mode that
-- is actually running. A derived primary key has no null semantics to get wrong.
CREATE TABLE IF NOT EXISTS "StatisticBucket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "sumCents" BIGINT NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatisticBucket_pkey" PRIMARY KEY ("id")
);

-- The read path: "this metric, this period, over this range" — every chart on
-- the Reports page. tenantId LEADS for the same reason it leads the journey
-- retention indexes: reads and the rollup both run inside a tenant scope, so
-- the emitted query is `tenantId = $1 AND metric = $2 AND period = $3 AND
-- bucketStart >= $4`, and without tenantId first one workspace's buckets are
-- walked by every other workspace's query.
CREATE INDEX IF NOT EXISTS "StatisticBucket_tenantId_metric_period_bucketStart_idx"
  ON "StatisticBucket"("tenantId", "metric", "period", "bucketStart");

-- The retention sweep's early-out: "are there day buckets older than the
-- cutoff?", asked once per tenant per tick and answered "no" almost always. The
-- index above cannot serve it — the sweep does not name a metric, and metric
-- sits between period and bucketStart.
CREATE INDEX IF NOT EXISTS "StatisticBucket_tenantId_period_bucketStart_idx"
  ON "StatisticBucket"("tenantId", "period", "bucketStart");

CREATE INDEX IF NOT EXISTS "StatisticBucket_tenantId_idx"
  ON "StatisticBucket"("tenantId");

-- -----------------------------------------------------------------------------
-- StatisticCursor — how far the rollup has consumed each source's change clock.
-- -----------------------------------------------------------------------------
-- One row per (tenant, source), not per metric: the three Lead metrics share
-- Lead's `updatedAt`, so they share one probe.
CREATE TABLE IF NOT EXISTS "StatisticCursor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "source" TEXT NOT NULL,
    "cursorAt" TIMESTAMP(3) NOT NULL,
    "cursorId" TEXT NOT NULL DEFAULT '',
    "backfilledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatisticCursor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StatisticCursor_tenantId_idx"
  ON "StatisticCursor"("tenantId");

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
-- FORCE RLS is live on every tenant table from 20260727130000_rls_enforce. A new
-- tenant table that skips this is not "safe by default" — it is the one table in
-- the schema with no row-level boundary, and it is a table of AGGREGATES, where
-- a leak is not a visible foreign record but two workspaces' numbers silently
-- summed into one chart.
ALTER TABLE "StatisticBucket" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StatisticBucket_tenant_isolation" ON "StatisticBucket";
CREATE POLICY "StatisticBucket_tenant_isolation" ON "StatisticBucket"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StatisticBucket" FORCE ROW LEVEL SECURITY;

ALTER TABLE "StatisticCursor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StatisticCursor_tenant_isolation" ON "StatisticCursor";
CREATE POLICY "StatisticCursor_tenant_isolation" ON "StatisticCursor"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StatisticCursor" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Source-table indexes for the rollup
-- -----------------------------------------------------------------------------
-- ⚠ THESE ARE DECLARED HERE ONLY, NOT IN prisma/schema.prisma.
--
-- "Lead" and "JobCard" live in prisma/schema.prisma, which parallel work has
-- open; adding four @@index lines to those models would conflict textually. The
-- indexes are therefore created here and are invisible to the Prisma schema.
-- That divergence is SAFE with this repo's tooling but it is a debt, so it is
-- worth being precise about both halves:
--
--   safe   — the deploy-time integrity probe (scripts/apply-migrations.mjs,
--            assertSchemaObjectsPresent) diffs FROM the database TO the schema
--            and blocks only on CREATE TABLE / ADD COLUMN, i.e. objects the
--            database LACKS. An index the database has and the schema does not
--            appears as a DROP, which classifyDiffScript ignores outright.
--   debt   — a future `prisma migrate dev` run against schema.prisma would
--            generate a DROP for them. Fold the four @@index lines into the
--            Lead and JobCard models once schema.prisma is free.
--
-- tenantId LEADS all four. The rollup runs inside a tenant scope
-- (runCronPerTenant), so every query below is emitted as `tenantId = $1 AND …`.
-- Without tenantId first, the quietest workspace's early-out pays for the
-- busiest workspace's history on every single tick — the exact failure the
-- journey retention indexes were reshaped to avoid.
--
-- HONEST CAVEAT: while TENANT_ENFORCEMENT is dormant the extension adds no
-- tenantId predicate, so Postgres cannot use a tenant-leading index for these
-- (there is no skip scan). Dormant mode is single-tenant by construction, and
-- the alternative — a second, tenant-blind copy of each index — costs write
-- throughput on the two hottest tables in the CRM to optimise a mode the
-- platform is migrating off. The journey retention indexes made the same trade.

-- The change probe and the cursor position: `updatedAt > $2 OR (updatedAt = $2
-- AND id > $3)`, ordered (updatedAt, id). `id` is in the index so the ORDER BY
-- is satisfied by the scan rather than by a sort of every tied row.
-- This also serves the deals_won / deals_lost window aggregate, which ranges on
-- "updatedAt" — the app's existing proxy for the date a deal closed.
CREATE INDEX IF NOT EXISTS "Lead_tenantId_updatedAt_id_idx"
  ON "Lead"("tenantId", "updatedAt", "id");

-- The leads_created window aggregate ranges on "createdAt", which nothing
-- indexed. Without this the rollup sequential-scans "Lead" every time a lead is
-- touched — which, on a working CRM, is every tick.
CREATE INDEX IF NOT EXISTS "Lead_tenantId_createdAt_idx"
  ON "Lead"("tenantId", "createdAt");

CREATE INDEX IF NOT EXISTS "JobCard_tenantId_updatedAt_id_idx"
  ON "JobCard"("tenantId", "updatedAt", "id");

-- The jobcards_completed window aggregate ranges on "completedAt".
CREATE INDEX IF NOT EXISTS "JobCard_tenantId_completedAt_idx"
  ON "JobCard"("tenantId", "completedAt");
