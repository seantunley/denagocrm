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
-- NOT built CONCURRENTLY, deliberately, though these are the tables where a
-- blocking build hurts most. Prisma Migrate wraps each migration in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one, so a
-- CONCURRENTLY build here does not trade a lock for availability — it fails the
-- migration outright and ships no index at all. A brief ACCESS EXCLUSIVE lock
-- during deploy is recoverable; a permanently missing index is the thing this
-- file exists to prevent.
--
-- If these tables ever grow large enough that the build window matters, the
-- answer is to run the two statements by hand with CONCURRENTLY ahead of the
-- deploy — IF NOT EXISTS then makes this migration a no-op.

-- JourneyEvent: processed/failed events older than the cutoff.
CREATE INDEX IF NOT EXISTS "JourneyEvent_status_createdAt_idx"
  ON "JourneyEvent"("status", "createdAt");

-- JourneyRun: CLOSED runs older than the cutoff. The existing
-- [status, nextRunAt] index cannot serve this — nextRunAt is null on closed
-- runs, which is precisely the set being scanned.
CREATE INDEX IF NOT EXISTS "JourneyRun_status_createdAt_idx"
  ON "JourneyRun"("status", "createdAt");
