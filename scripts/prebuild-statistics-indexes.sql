-- Build the reporting-statistics SOURCE-TABLE indexes WITHOUT locking out writes.
--
-- Run this against the target database BEFORE deploying migration
-- 20260804120000_reporting_statistics. That migration creates the same seven
-- indexes with IF NOT EXISTS, so once these exist it is a no-op for them and the
-- deploy takes no lock on "Lead" or "JobCard" at all.
--
-- THIS IS A PRECONDITION, NOT ADVICE. On a table big enough for the lock to
-- matter (32 MB or 100k rows, whichever comes first) the migration REFUSES TO
-- RUN while any of these indexes is missing, and prints this filename. It is not
-- a warning in a comment that a deploy can sail past; it fails the deploy. On a
-- small or empty database — CI, disaster recovery, a new workspace — the
-- migration builds them inline and this script is unnecessary.
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
-- table is silently unindexed and the rollup silently sequential-scans it. Note
-- that the migration's precondition check only asks whether the index EXISTS, so
-- an invalid one satisfies it while helping nothing. Check for one and drop it
-- before retrying:
--
--   SELECT i.indexrelid::regclass AS invalid_index
--   FROM pg_index i
--   WHERE NOT i.indisvalid
--     AND i.indrelid IN ('"Lead"'::regclass, '"JobCard"'::regclass);
--
--   -- then, for each:  DROP INDEX CONCURRENTLY "<name>";
--
-- ── the escape hatch ─────────────────────────────────────────────────────────
--
-- If the write pause is acceptable — a maintenance window, a restore into a
-- database nothing is talking to — tell the migration so explicitly instead of
-- running this script:
--
--   SET app.allow_blocking_index_build = 'on';
--
-- in the same session, before applying migrations.

-- These must match the migration EXACTLY — same names, same columns, same
-- order. If they drift, IF NOT EXISTS stops making the migration a no-op, the
-- precondition check still sees a missing index, and the deploy fails.
--
-- tenantId leads all seven because the rollup names the tenant in every query it
-- makes — whether or not enforcement is on — so every one is emitted as
-- `tenantId = $1 AND …`.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenantId_updatedAt_id_idx"
  ON "Lead"("tenantId", "updatedAt", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenantId_createdAt_idx"
  ON "Lead"("tenantId", "createdAt");

-- deals_won / deals_lost range on the IMMUTABLE lifecycle dates, not on
-- "updatedAt" — see the long note in the migration. These two serve those
-- aggregates and the MIN() probe that gives the backfill walk a floor.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenantId_wonAt_idx"
  ON "Lead"("tenantId", "wonAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenantId_lostAt_idx"
  ON "Lead"("tenantId", "lostAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobCard_tenantId_updatedAt_id_idx"
  ON "JobCard"("tenantId", "updatedAt", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobCard_tenantId_createdAt_idx"
  ON "JobCard"("tenantId", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobCard_tenantId_completedAt_idx"
  ON "JobCard"("tenantId", "completedAt");
