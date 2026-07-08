-- Customer feedback surveys (CSAT, NPS, post-sale, ad-hoc)
CREATE TABLE "Survey" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'adhoc',
    "intro" TEXT,
    "thankYou" TEXT,
    "questions" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "jobCardId" TEXT,
    "name" TEXT,
    "channel" TEXT,
    "answers" JSONB,
    "score" INTEGER,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurveyResponse_token_key" ON "SurveyResponse"("token");
CREATE INDEX "Survey_type_active_idx" ON "Survey"("type", "active");
CREATE INDEX "SurveyResponse_surveyId_status_idx" ON "SurveyResponse"("surveyId", "status");
CREATE INDEX "SurveyResponse_contactId_idx" ON "SurveyResponse"("contactId");

ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
