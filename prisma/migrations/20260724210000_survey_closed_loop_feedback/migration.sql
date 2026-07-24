CREATE TABLE IF NOT EXISTS "SurveyFollowUp" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "surveyResponseId" TEXT NOT NULL,
  "distributionId" TEXT,
  "contactId" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "status" TEXT NOT NULL DEFAULT 'open',
  "ownerId" TEXT,
  "dueAt" TIMESTAMP(3),
  "caseId" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "SurveyFollowUp_response_key" ON "SurveyFollowUp"("surveyResponseId");
CREATE INDEX IF NOT EXISTS "SurveyFollowUp_tenant_status_due_idx" ON "SurveyFollowUp"("tenantId", "status", "dueAt");
CREATE INDEX IF NOT EXISTS "SurveyFollowUp_contact_idx" ON "SurveyFollowUp"("contactId", "createdAt" DESC);

CREATE OR REPLACE FUNCTION denago_create_survey_follow_up()
RETURNS trigger AS $$
DECLARE
  survey_type TEXT;
  should_follow BOOLEAN := false;
  follow_severity TEXT := 'medium';
BEGIN
  IF NEW."status" = 'completed' AND OLD."status" IS DISTINCT FROM 'completed' AND NEW."score" IS NOT NULL THEN
    SELECT s."type" INTO survey_type FROM "Survey" s WHERE s."id" = NEW."surveyId";
    IF survey_type = 'nps' AND NEW."score" <= 6 THEN
      should_follow := true;
      follow_severity := CASE WHEN NEW."score" <= 3 THEN 'critical' ELSE 'high' END;
    ELSIF survey_type IN ('csat', 'sales') AND NEW."score" <= 2 THEN
      should_follow := true;
      follow_severity := CASE WHEN NEW."score" <= 1 THEN 'critical' ELSE 'high' END;
    END IF;

    IF should_follow THEN
      INSERT INTO "SurveyFollowUp" (
        "id", "tenantId", "surveyResponseId", "distributionId", "contactId", "severity", "status", "dueAt"
      ) VALUES (
        'sfu_' || md5(NEW."id"), NEW."tenantId", NEW."id", NEW."distributionId", NEW."contactId",
        follow_severity, 'open', CURRENT_TIMESTAMP + CASE WHEN follow_severity = 'critical' THEN INTERVAL '4 hours' ELSE INTERVAL '1 day' END
      ) ON CONFLICT ("surveyResponseId") DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SurveyResponse_closed_loop_follow_up" ON "SurveyResponse";
CREATE TRIGGER "SurveyResponse_closed_loop_follow_up"
AFTER UPDATE OF "status", "score" ON "SurveyResponse"
FOR EACH ROW EXECUTE FUNCTION denago_create_survey_follow_up();
