-- Nested journey flow: choose / repeat, a path cursor, and hierarchical traces.
--
-- Three changes, all forced by the same thing: a step can now execute more than
-- once in a run, and a run can be parked INSIDE a container step.

-- 1. WHERE INSIDE a choose/repeat a run is: { stepId, frames[] }.
--
-- NULL is meaningful and is what every existing row keeps: the runner reads a
-- null cursor as { stepId: currentStepId, frames: [] }, which is exactly the
-- flat behaviour those runs already have. Deliberately NOT backfilled — writing
-- a synthetic cursor into rows that do not need one would only create a second
-- representation of the same position, and the two could then disagree.
ALTER TABLE "JourneyRun" ADD COLUMN IF NOT EXISTS "cursor" JSONB;

-- 2. Lifetime steps executed. Replaces a per-tick `visited` Set of step ids that
-- could not survive `repeat` (which re-executes the same ids on purpose) and
-- never caught the real infinite automation anyway, because it was rebuilt empty
-- on every tick. Existing runs start at 0: they are part-way through, so their
-- remaining budget is generous rather than accurate, which is the safe direction.
ALTER TABLE "JourneyRun" ADD COLUMN IF NOT EXISTS "stepsExecuted" INTEGER NOT NULL DEFAULT 0;

-- 3. The hierarchical trace path on step logs.
--
-- Added nullable, backfilled from stepId, then made NOT NULL — the three-step
-- form, because the table has rows and a bare NOT NULL column would fail on
-- them. For a top-level step the path IS the step id, so this backfill is not an
-- approximation: it is the value the runner would now write for those same rows.
ALTER TABLE "JourneyStepLog" ADD COLUMN IF NOT EXISTS "path" TEXT;
UPDATE "JourneyStepLog" SET "path" = "stepId" WHERE "path" IS NULL;
ALTER TABLE "JourneyStepLog" ALTER COLUMN "path" SET NOT NULL;

-- Uniqueness moves from (runId, stepId) to (runId, path).
--
-- (runId, stepId) CANNOT hold once a step executes once per repeat iteration.
-- The new key can, because the path carries the iteration:
--   blast/repeat/0/sequence/1  and  blast/repeat/2/sequence/1  are distinct.
--
-- Dropping the old one is safe in this order: every existing row has
-- path = stepId, so (runId, path) is unique wherever (runId, stepId) was.
CREATE UNIQUE INDEX IF NOT EXISTS "JourneyStepLog_runId_path_key"
  ON "JourneyStepLog" ("runId", "path");
DROP INDEX IF EXISTS "JourneyStepLog_runId_stepId_key";

-- stepId stays queryable — it is what a person recognises, and the trace UI
-- reads it — but as a plain index now that it is no longer unique per run.
CREATE INDEX IF NOT EXISTS "JourneyStepLog_runId_stepId_idx"
  ON "JourneyStepLog" ("runId", "stepId");
