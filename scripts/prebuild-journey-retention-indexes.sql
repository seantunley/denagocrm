-- Build the journey-retention indexes WITHOUT locking out writes.
--
-- Run this against the target database BEFORE deploying migration
-- 20260803100000_journey_retention_indexes. That migration creates the same two
-- indexes with IF NOT EXISTS, so once these exist it is a no-op and the deploy
-- takes no lock at all.
--
-- ── why this file exists ─────────────────────────────────────────────────────
--
-- A plain CREATE INDEX takes a SHARE lock on the table, which blocks INSERT,
-- UPDATE and DELETE for the whole build. CREATE INDEX CONCURRENTLY does not: it
-- makes two passes and lets writes continue throughout.
--
-- The migration cannot use CONCURRENTLY, because Prisma Migrate wraps each
-- migration in a transaction and CONCURRENTLY cannot run inside one — it fails
-- the migration outright rather than trading a lock for availability.
--
-- These are also the two tables where a write-blocking build hurts most, and
-- that is not incidental: they are the largest tables in the schema, which is
-- the entire reason the retention sweep was written. On a workspace that has
-- been running journeys for a year, "brief" is not a safe assumption.
--
-- ── how to run ───────────────────────────────────────────────────────────────
--
--   psql "$DATABASE_URL_UNPOOLED" -f scripts/prebuild-journey-retention-indexes.sql
--
-- Use the UNPOOLED url: CONCURRENTLY cannot run inside a transaction, and a
-- pooler in transaction mode will wrap it in one.
--
-- Safe to re-run. If a build is interrupted, Postgres leaves an INVALID index
-- behind — it is not used by the planner and not repaired automatically. Check
-- for one and drop it before retrying:
--
--   SELECT i.indexrelid::regclass AS invalid_index
--   FROM pg_index i
--   WHERE NOT i.indisvalid
--     AND i.indrelid IN ('"JourneyEvent"'::regclass, '"JourneyRun"'::regclass);
--
--   -- then, for each:  DROP INDEX CONCURRENTLY "<name>";
--
-- If the tables are small — a new or low-volume workspace — none of this is
-- necessary: deploy the migration directly and let it build them inline.

-- These must match the migration EXACTLY — same names, same columns, same
-- order. If they drift, IF NOT EXISTS stops making the migration a no-op and
-- the deploy takes the write-blocking lock this script exists to avoid.
--
-- tenantId leads because the sweep runs inside a tenant scope, so the query is
-- `tenantId = $1 AND status IN (…) AND createdAt < $2`.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JourneyEvent_tenantId_status_createdAt_idx"
  ON "JourneyEvent"("tenantId", "status", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JourneyRun_tenantId_status_createdAt_idx"
  ON "JourneyRun"("tenantId", "status", "createdAt");
