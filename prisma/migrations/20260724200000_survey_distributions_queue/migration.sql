CREATE TABLE IF NOT EXISTS "SurveyDistribution" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "surveyId" TEXT NOT NULL,
  "surveyVersion" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'survey_transactional',
  "channel" TEXT NOT NULL DEFAULT 'any',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "audienceSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "scheduledFor" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "reminderAfterHours" INTEGER NOT NULL DEFAULT 48,
  "maxReminders" INTEGER NOT NULL DEFAULT 1,
  "totalCount" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "completedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "suppressedCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SurveyDistribution_tenant_status_idx" ON "SurveyDistribution"("tenantId", "status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "SurveyDistribution_survey_version_idx" ON "SurveyDistribution"("surveyId", "surveyVersion");

ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "distributionId" TEXT;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "suppressionReason" TEXT;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "providerStatus" TEXT;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "reminderCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMP(3);
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "inviteSentAt" TIMESTAMP(3);
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "openedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SurveyResponse_distribution_status_idx" ON "SurveyResponse"("distributionId", "status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "SurveyResponse_tenant_queue_idx" ON "SurveyResponse"("tenantId", "status", "scheduledFor");
CREATE UNIQUE INDEX IF NOT EXISTS "SurveyResponse_distribution_contact_key"
  ON "SurveyResponse"("distributionId", "contactId")
  WHERE "distributionId" IS NOT NULL AND "contactId" IS NOT NULL;
