-- Proactive DAX, part 3 (Sean, 2026-10-18): DAX can set itself a check-back from
-- a conversation ("I'll check on Thursday whether Anna signed"). It is a one-off
-- scheduled question marked as set by DAX, with why. Existing rows are the
-- person's own. Additive only; re-runnable.
ALTER TABLE "AssistantSchedule" ADD COLUMN IF NOT EXISTS "setBy" TEXT NOT NULL DEFAULT 'person';
ALTER TABLE "AssistantSchedule" ADD COLUMN IF NOT EXISTS "reason" TEXT;
