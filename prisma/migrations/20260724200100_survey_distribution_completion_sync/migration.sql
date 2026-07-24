CREATE OR REPLACE FUNCTION denago_sync_survey_distribution_completion()
RETURNS trigger AS $$
BEGIN
  IF NEW."distributionId" IS NOT NULL
     AND NEW."status" = 'completed'
     AND OLD."status" IS DISTINCT FROM 'completed' THEN
    UPDATE "SurveyDistribution"
    SET "completedCount" = "completedCount" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = NEW."distributionId"
      AND "tenantId" IS NOT DISTINCT FROM NEW."tenantId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SurveyResponse_distribution_completion_sync" ON "SurveyResponse";
CREATE TRIGGER "SurveyResponse_distribution_completion_sync"
AFTER UPDATE OF "status" ON "SurveyResponse"
FOR EACH ROW EXECUTE FUNCTION denago_sync_survey_distribution_completion();
