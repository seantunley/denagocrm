-- Why each active journey did or did not enrol on an event.
--
-- Additive and nullable: existing rows keep NULL, which the UI renders as
-- "recorded before tracing existed" rather than as "nothing was considered".
ALTER TABLE "JourneyEvent" ADD COLUMN IF NOT EXISTS "decisions" JSONB;
