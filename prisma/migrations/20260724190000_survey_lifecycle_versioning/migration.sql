DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Survey' AND column_name = 'status'
  ) THEN
    ALTER TABLE "Survey" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';
    UPDATE "Survey"
    SET "status" = CASE WHEN "active" = true THEN 'published' ELSE 'inactive' END;
  END IF;
END $$;

ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "publishedVersion" INTEGER;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "submittedForReviewAt" TIMESTAMP(3);
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "submittedById" TEXT;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "approvedById" TEXT;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "changesRequestedAt" TIMESTAMP(3);
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;
ALTER TABLE "Survey" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "surveyVersion" INTEGER;

CREATE TABLE IF NOT EXISTS "SurveyVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "surveyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedById" TEXT,
  "label" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "SurveyVersion_surveyId_version_key" ON "SurveyVersion"("surveyId", "version");
CREATE INDEX IF NOT EXISTS "SurveyVersion_tenantId_idx" ON "SurveyVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "SurveyVersion_survey_published_idx" ON "SurveyVersion"("surveyId", "publishedAt" DESC);

INSERT INTO "SurveyVersion" ("id", "tenantId", "surveyId", "version", "snapshot", "publishedAt", "publishedById", "label")
SELECT 'sv_legacy_' || md5(s."id"), s."tenantId", s."id", 1,
  jsonb_build_object(
    'title', s."title",
    'type', s."type",
    'intro', s."intro",
    'thankYou', s."thankYou",
    'questions', s."questions",
    'trigger', s."trigger",
    'delayHours', s."delayHours"
  ),
  s."createdAt", s."createdById", 'Historical version'
FROM "Survey" s
WHERE s."status" IN ('published', 'inactive')
  AND NOT EXISTS (SELECT 1 FROM "SurveyVersion" v WHERE v."surveyId" = s."id")
ON CONFLICT DO NOTHING;

UPDATE "Survey"
SET "publishedVersion" = 1
WHERE "status" IN ('published', 'inactive')
  AND "publishedVersion" IS NULL
  AND EXISTS (SELECT 1 FROM "SurveyVersion" v WHERE v."surveyId" = "Survey"."id" AND v."version" = 1);

UPDATE "SurveyResponse" r
SET "surveyVersion" = COALESCE(s."publishedVersion", 1)
FROM "Survey" s
WHERE r."surveyId" = s."id" AND r."surveyVersion" IS NULL;

CREATE INDEX IF NOT EXISTS "SurveyResponse_survey_version_idx" ON "SurveyResponse"("surveyId", "surveyVersion");
CREATE UNIQUE INDEX IF NOT EXISTS "Survey_one_active_trigger_per_tenant"
  ON "Survey"("tenantId", "trigger")
  WHERE "active" = true AND "trigger" IS NOT NULL AND "deletedAt" IS NULL;
