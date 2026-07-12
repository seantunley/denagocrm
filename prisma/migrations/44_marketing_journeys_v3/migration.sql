-- Versioned, durable marketing journeys and multi-step CRM automations.
-- These tables are intentionally additive so the existing AutomationRule engine
-- continues to run while journeys are migrated and validated.

CREATE TABLE "MarketingJourney" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL DEFAULT 'marketing',
  "trigger" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
  "respectMarketingConsent" BOOLEAN NOT NULL DEFAULT true,
  "frequencyCapHours" INTEGER NOT NULL DEFAULT 24,
  "currentDraftVersionId" TEXT,
  "publishedVersionId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "MarketingJourney_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingJourneyVersion" (
  "id" TEXT NOT NULL,
  "journeyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "definition" JSONB NOT NULL,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "MarketingJourneyVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingJourneyEnrollment" (
  "id" TEXT NOT NULL,
  "journeyId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "leadId" TEXT,
  "contactId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "currentStep" INTEGER NOT NULL DEFAULT 0,
  "wakeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "stoppedReason" TEXT,
  "lastMessageAt" TIMESTAMP(3),
  "state" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingJourneyEnrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketingJourneyEnrollment_subject_check" CHECK ("leadId" IS NOT NULL OR "contactId" IS NOT NULL)
);

CREATE TABLE "MarketingJourneyStepRun" (
  "id" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "stepIndex" INTEGER NOT NULL,
  "stepType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "output" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "MarketingJourneyStepRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MarketingJourneyVersion"
  ADD CONSTRAINT "MarketingJourneyVersion_journeyId_fkey"
  FOREIGN KEY ("journeyId") REFERENCES "MarketingJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketingJourneyEnrollment"
  ADD CONSTRAINT "MarketingJourneyEnrollment_journeyId_fkey"
  FOREIGN KEY ("journeyId") REFERENCES "MarketingJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketingJourneyEnrollment"
  ADD CONSTRAINT "MarketingJourneyEnrollment_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "MarketingJourneyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MarketingJourneyStepRun"
  ADD CONSTRAINT "MarketingJourneyStepRun_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "MarketingJourneyEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "MarketingJourneyVersion_journeyId_version_key"
  ON "MarketingJourneyVersion"("journeyId", "version");
CREATE INDEX "MarketingJourney_trigger_active_idx"
  ON "MarketingJourney"("trigger", "active");
CREATE INDEX "MarketingJourneyEnrollment_due_idx"
  ON "MarketingJourneyEnrollment"("status", "wakeAt");
CREATE INDEX "MarketingJourneyEnrollment_lead_idx"
  ON "MarketingJourneyEnrollment"("leadId", "status");
CREATE INDEX "MarketingJourneyEnrollment_contact_idx"
  ON "MarketingJourneyEnrollment"("contactId", "status");
CREATE UNIQUE INDEX "MarketingJourneyEnrollment_active_lead_key"
  ON "MarketingJourneyEnrollment"("journeyId", "versionId", "leadId")
  WHERE "leadId" IS NOT NULL AND "status" IN ('active', 'waiting');
CREATE UNIQUE INDEX "MarketingJourneyEnrollment_active_contact_key"
  ON "MarketingJourneyEnrollment"("journeyId", "versionId", "contactId")
  WHERE "contactId" IS NOT NULL AND "status" IN ('active', 'waiting');
CREATE INDEX "MarketingJourneyStepRun_enrollment_idx"
  ON "MarketingJourneyStepRun"("enrollmentId", "startedAt");
