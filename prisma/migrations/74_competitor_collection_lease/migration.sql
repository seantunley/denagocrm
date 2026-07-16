-- Competitor source collection lease: prevents overlapping manual/cron runs from
-- double-processing a source. Additive.

ALTER TABLE "CompetitorSource" ADD COLUMN "collectingAt" TIMESTAMP(3);
