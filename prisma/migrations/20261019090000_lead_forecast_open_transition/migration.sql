-- Review of #902. The live sync_lead_pipeline_forecast() never had migration
-- 52's "open" branch (production held won/lost only), so 20261018110000 would
-- switch it on for EVERY update of an open lead's stage — and, on the next drag,
-- silently undo a rep's own "omitted" forecast category (and probability) on an
-- open deal. Here the open branch runs only when a lead BECOMES open (reopened,
-- or reactivated from nurture), which is all it was for. Additive; re-runnable.

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
  ELSIF NEW."status" = 'open' AND TG_OP = 'UPDATE' AND OLD."status" IS DISTINCT FROM 'open' THEN
    NEW."wonAt" := NULL; NEW."lostAt" := NULL;
    IF NEW."forecastCategory" IN ('closed','omitted') THEN
      NEW."forecastCategory" := 'pipeline';
      NEW."probability" := COALESCE(stage_probability, 10);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
