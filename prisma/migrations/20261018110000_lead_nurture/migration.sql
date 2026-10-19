-- Additive: existing leads remain unchanged. Nurture is neither a win nor a loss.
ALTER TABLE "Lead"
  ADD COLUMN IF NOT EXISTS "nurtureSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nurtureReason" TEXT,
  ADD COLUMN IF NOT EXISTS "nurtureInterest" TEXT,
  ADD COLUMN IF NOT EXISTS "nurtureTrigger" TEXT,
  ADD COLUMN IF NOT EXISTS "nurtureReviewAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nurtureActivityId" TEXT;
CREATE INDEX IF NOT EXISTS "Lead_nurture_review_idx" ON "Lead" ("tenantId", "nurtureReviewAt")
  WHERE "status" = 'nurture' AND "deletedAt" IS NULL;

-- Reuse the existing trigger. Reactivation restores the selected stage's probability.
CREATE OR REPLACE FUNCTION sync_lead_pipeline_forecast() RETURNS trigger AS $$
DECLARE stage_pipeline TEXT; stage_probability INTEGER;
BEGIN
  SELECT "pipelineId", "defaultProbability" INTO stage_pipeline, stage_probability
  FROM "PipelineStage" WHERE "id" = NEW."stageId";
  IF stage_pipeline IS NOT NULL THEN NEW."pipelineId" := stage_pipeline; END IF;
  IF TG_OP = 'INSERT' AND (NEW."probability" IS NULL OR NEW."probability" = 10) THEN
    NEW."probability" := COALESCE(stage_probability, 10);
  END IF;
  IF NEW."status" = 'won' THEN
    NEW."forecastCategory" := 'closed'; NEW."probability" := 100;
    NEW."wonAt" := COALESCE(NEW."wonAt", CURRENT_TIMESTAMP);
  ELSIF NEW."status" = 'lost' THEN
    NEW."forecastCategory" := 'omitted'; NEW."probability" := 0;
    NEW."lostAt" := COALESCE(NEW."lostAt", CURRENT_TIMESTAMP);
  ELSIF NEW."status" = 'nurture' THEN
    NEW."forecastCategory" := 'omitted'; NEW."probability" := 0;
    NEW."wonAt" := NULL; NEW."lostAt" := NULL;
  ELSIF NEW."status" = 'open' THEN
    NEW."wonAt" := NULL; NEW."lostAt" := NULL;
    IF NEW."forecastCategory" IN ('closed','omitted') THEN
      NEW."forecastCategory" := 'pipeline';
      NEW."probability" := COALESCE(stage_probability, 10);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
