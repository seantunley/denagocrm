-- Indexes for the journey trace retention sweep (src/lib/journeyRetention.ts).
--
-- TIMESTAMP-PREFIXED, and it has to be. scripts/apply-migrations.mjs orders by
-- `Number.parseInt(name, 10)`, NOT lexicographically, so every timestamped
-- migration runs after every numerically-prefixed one. The journey tables are
-- created in 20260712160000_add_marketing_journeys; a `81_`-style name would
-- sort as 81, run long before that, and fail with `relation "JourneyEvent" does
-- not exist`. Anything touching a journey table must be timestamped.
--
-- The sweep's first act is an early-out: "is there anything old enough to
-- delete?". That question is asked once PER TENANT on every journey cron tick
-- (runCronPerTenant establishes a scope and calls runJourneyEngine inside it),
-- and the answer is almost always no. Without an index that is a sequential
-- scan of the two largest tables in the schema, on every tick, to find nothing
-- — housekeeping costing more than the growth it exists to control.
--
-- ⚠ THIS BUILD BLOCKS WRITES. READ scripts/prebuild-journey-retention-indexes.sql
-- BEFORE DEPLOYING TO A BUSY DATABASE.
--
-- A plain CREATE INDEX takes a SHARE lock, which blocks INSERT/UPDATE/DELETE on
-- the table for the whole build. It cannot be CONCURRENTLY here: Prisma Migrate
-- wraps each migration in a transaction, and CONCURRENTLY cannot run inside one
-- — it would fail the migration outright and ship no index at all.
--
-- I originally called that lock "brief". That was an assumption, not a
-- measurement, and it is the wrong way round: these are the two largest tables
-- in the schema, which is the entire reason the retention sweep exists. On a
-- workspace that has been running journeys for a year, the build is not brief.
--
-- So the concurrent path is a real, runnable artifact rather than a note:
--
--   psql "$DATABASE_URL_UNPOOLED" -f scripts/prebuild-journey-retention-indexes.sql
--
-- Run it BEFORE the deploy. IF NOT EXISTS then makes this migration a no-op and
-- the deploy takes no lock at all. On a small or new database, skip it and let
-- this build them inline.

-- tenantId LEADS both indexes. The sweep runs inside a tenant scope
-- (runCronPerTenant), so the query the Prisma extension actually emits is
--   tenantId = $1 AND status IN (…) AND createdAt < $2
-- Ordered (status, createdAt), a tenant with nothing to prune still walks the
-- expired entries of every OTHER tenant before returning empty — the busiest
-- workspace would set the cost of the quietest one's early-out, on every tick.

-- JourneyEvent: processed/failed events older than the cutoff.
CREATE INDEX IF NOT EXISTS "JourneyEvent_tenantId_status_createdAt_idx"
  ON "JourneyEvent"("tenantId", "status", "createdAt");

-- JourneyRun: CLOSED runs older than the cutoff. The existing
-- [status, nextRunAt] index cannot serve this — nextRunAt is null on closed
-- runs, which is precisely the set being scanned.
CREATE INDEX IF NOT EXISTS "JourneyRun_tenantId_status_createdAt_idx"
  ON "JourneyRun"("tenantId", "status", "createdAt");
