-- Track when a lead entered its current stage (drives the stale-age flag)
ALTER TABLE "Lead" ADD COLUMN "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
