ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenant_queue_due_idx"
  ON "CampaignRecipient"("tenantId", "status", "nextAttemptAt", "campaignId");

CREATE INDEX IF NOT EXISTS "Campaign_tenant_schedule_status_idx"
  ON "Campaign"("tenantId", "status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "Survey_tenant_lifecycle_idx"
  ON "Survey"("tenantId", "status", "active", "trigger");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Campaign_attribution_window_days_check') THEN
    ALTER TABLE "Campaign"
      ADD CONSTRAINT "Campaign_attribution_window_days_check"
      CHECK ("attributionWindowDays" BETWEEN 1 AND 180) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SurveyDistribution_reminder_bounds_check') THEN
    ALTER TABLE "SurveyDistribution"
      ADD CONSTRAINT "SurveyDistribution_reminder_bounds_check"
      CHECK ("reminderAfterHours" >= 1 AND "maxReminders" BETWEEN 0 AND 3) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION denago_reconcile_campaign_conversion_totals(p_campaign_id TEXT)
RETURNS TABLE("conversionCount" INTEGER, "attributedRevenueCents" INTEGER) AS $$
BEGIN
  RETURN QUERY
  SELECT COUNT(*)::INTEGER,
    COALESCE(SUM(c."valueCents") FILTER (WHERE c."conversionType" = 'sale_won'), 0)::INTEGER
  FROM "CampaignConversion" c
  WHERE c."campaignId" = p_campaign_id;
END;
$$ LANGUAGE plpgsql STABLE;
