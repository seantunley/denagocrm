-- Build the reporting-statistics SOURCE-TABLE indexes WITHOUT locking out writes.
--
-- Run this against the target database BEFORE deploying migration
-- 20260804120000_reporting_statistics. That migration creates the same four
-- indexes with IF NOT EXISTS, so once these exist it is a no-op for them and the
-- deploy takes no lock on "Lead" or "JobCard" at all.
--
-- ── why this file exists ─────────────────────────────────────────────────────
--
-- A plain CREATE INDEX takes a SHARE lock on the table, which blocks INSERT,
-- UPDATE and DELETE for the whole build. CREATE INDEX CONCURRENTLY does not: it
-- makes two passes and lets writes continue throughout.
--
-- The migration cannot use CONCURRENTLY, because Prisma Migrate wraps each
-- migration in a transaction and CONCURRENTLY cannot run inside one — it would
-- fail the migration outright and ship no index at all, which is strictly worse
-- than the lock.
--
-- "Lead" is the busiest table in the CRM: every intake webhook, every stage
-- drag, every journey touch writes to it. Blocking writes to it for the length
-- of an index build over a workspace's whole sales history is not a "brief"
-- deploy pause, and assuming otherwise is how a deploy becomes an outage.
--
-- The four indexes in the same migration on "StatisticBucket" and
-- "StatisticCursor" are NOT listed here on purpose: those tables are created
-- empty by the same migration, so their builds lock nothing.
--
-- ── how to run ───────────────────────────────────────────────────────────────
--
--   psql "$DATABASE_URL_UNPOOLED" -f scripts/prebuild-statistics-indexes.sql
--
-- Use the UNPOOLED url: CONCURRENTLY cannot run inside a transaction, and a
-- pooler in transaction mode will wrap it in one.
--
-- Safe to re-run. If a build is interrupted, Postgres leaves an INVALID index
-- behind — the planner will not use it and Postgres will not repair it, so the
-- table is silently unindexed and the rollup silently sequential-scans it.
-- Check for one and drop it before retrying:
--
--   SELECT i.indexrelid::regclass AS invalid_index
--   FROM pg_index i
--   WHERE NOT i.indisvalid
--     AND i.indrelid IN ('"Lead"'::regclass, '"JobCard"'::regclass);
--
--   -- then, for each:  DROP INDEX CONCURRENTLY "<name>";
--
-- If the tables are small — a new or low-volume workspace — none of this is
-- necessary: deploy the migration directly and let it build them inline.

-- These must match the migration EXACTLY — same names, same columns, same
-- order. If they drift, IF NOT EXISTS stops making the migration a no-op and
-- the deploy takes the write-blocking lock this script exists to avoid.
--
-- tenantId leads all four because the rollup runs inside a tenant scope, so
-- every query is emitted as `tenantId = $1 AND …`.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenantId_updatedAt_id_idx"
  ON "Lead"("tenantId", "updatedAt", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenantId_createdAt_idx"
  ON "Lead"("tenantId", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobCard_tenantId_updatedAt_id_idx"
  ON "JobCard"("tenantId", "updatedAt", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobCard_tenantId_completedAt_idx"
  ON "JobCard"("tenantId", "completedAt");
