-- Optional send delay for surveys (e.g. a week after a service)
ALTER TABLE "Survey" ADD COLUMN "delayHours" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SurveyResponse" ADD COLUMN "scheduledFor" TIMESTAMP(3);
CREATE INDEX "SurveyResponse_status_scheduledFor_idx" ON "SurveyResponse"("status", "scheduledFor");
