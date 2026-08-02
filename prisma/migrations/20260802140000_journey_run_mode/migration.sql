-- Run mode: what happens when someone is enrolled again while a run is open.
--
-- DEFAULT 'parallel' for EXISTING rows, 'single' for new ones. Those differ on
-- purpose. Parallel is what every existing journey has been doing — the
-- idempotency key stopped a repeat of the same event, but a different event on
-- the same person started a second run and both sent. Backfilling those to
-- 'single' would silently change live behaviour on deploy; a journey that has
-- been sending twice would start dropping the second enrolment with nothing to
-- say why.
--
-- New journeys get 'single', which is what a drip sequence almost always wants.
-- Existing ones keep what they had and can be changed deliberately in the
-- builder.
ALTER TABLE "Journey" ADD COLUMN IF NOT EXISTS "runMode" TEXT NOT NULL DEFAULT 'parallel';

-- Now flip the column default so rows created from here on are 'single'. The
-- backfill above has already run, so this cannot reach existing rows.
ALTER TABLE "Journey" ALTER COLUMN "runMode" SET DEFAULT 'single';

-- A run parked behind another by run mode "queued". Deliberately NOT a foreign
-- key: the predecessor can be purged while this row still names it, and a
-- dangling id must leave the sweep free to release the waiter rather than
-- stranding it forever behind a run that no longer exists.
ALTER TABLE "JourneyRun" ADD COLUMN IF NOT EXISTS "blockedByRunId" TEXT;

-- The sweep looks up blocked runs by their predecessor, so index that way.
CREATE INDEX IF NOT EXISTS "JourneyRun_blockedByRunId_idx"
  ON "JourneyRun" ("blockedByRunId") WHERE "blockedByRunId" IS NOT NULL;
