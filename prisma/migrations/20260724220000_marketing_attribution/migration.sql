ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "utmSource" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "utmMedium" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "utmCampaign" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "utmContent" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "utmTerm" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "attributionWindowDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS "MarketingTouch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "campaignId" TEXT NOT NULL,
  "campaignRecipientId" TEXT,
  "contactId" TEXT,
  "type" TEXT NOT NULL,
  "targetUrl" TEXT,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,
  "utmTerm" TEXT,
  "eventKey" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingTouch_eventKey_key" ON "MarketingTouch"("eventKey");
CREATE INDEX IF NOT EXISTS "MarketingTouch_contact_time_idx" ON "MarketingTouch"("tenantId", "contactId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "MarketingTouch_campaign_time_idx" ON "MarketingTouch"("campaignId", "occurredAt" DESC);

CREATE TABLE IF NOT EXISTS "CampaignConversion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "campaignId" TEXT NOT NULL,
  "touchId" TEXT,
  "contactId" TEXT,
  "leadId" TEXT,
  "quoteId" TEXT,
  "conversionType" TEXT NOT NULL,
  "valueCents" INTEGER NOT NULL DEFAULT 0,
  "attributionModel" TEXT NOT NULL DEFAULT 'last_touch',
  "eventKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignConversion_eventKey_key" ON "CampaignConversion"("eventKey");
CREATE INDEX IF NOT EXISTS "CampaignConversion_campaign_type_idx" ON "CampaignConversion"("campaignId", "conversionType", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "CampaignConversion_contact_time_idx" ON "CampaignConversion"("tenantId", "contactId", "occurredAt" DESC);

CREATE OR REPLACE FUNCTION denago_latest_campaign_touch(p_tenant TEXT, p_contact TEXT, p_at TIMESTAMP(3))
RETURNS TABLE("touchId" TEXT, "campaignId" TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT t."id", t."campaignId"
  FROM "MarketingTouch" t
  JOIN "Campaign" c ON c."id" = t."campaignId"
  WHERE t."tenantId" IS NOT DISTINCT FROM p_tenant
    AND t."contactId" = p_contact
    AND t."type" = 'click'
    AND t."occurredAt" <= p_at
    AND t."occurredAt" >= p_at - (c."attributionWindowDays" * INTERVAL '1 day')
  ORDER BY t."occurredAt" DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION denago_record_lead_campaign_conversion()
RETURNS trigger AS $$
DECLARE
  latest RECORD;
  inserted_count INTEGER;
BEGIN
  IF NEW."contactId" IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO latest FROM denago_latest_campaign_touch(NEW."tenantId", NEW."contactId", NEW."createdAt");
    IF latest."campaignId" IS NOT NULL THEN
      INSERT INTO "CampaignConversion" (
        "id", "tenantId", "campaignId", "touchId", "contactId", "leadId", "conversionType", "valueCents", "eventKey", "occurredAt"
      ) VALUES (
        'cc_lead_' || md5(NEW."id"), NEW."tenantId", latest."campaignId", latest."touchId", NEW."contactId", NEW."id",
        'lead_created', COALESCE(NEW."valueCents", 0), 'lead_created:' || NEW."id", NEW."createdAt"
      ) ON CONFLICT ("eventKey") DO NOTHING;
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      IF inserted_count = 1 THEN
        UPDATE "Campaign" SET "conversionCount" = "conversionCount" + 1 WHERE "id" = latest."campaignId";
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" = 'won' AND OLD."status" IS DISTINCT FROM 'won' THEN
    SELECT * INTO latest FROM denago_latest_campaign_touch(NEW."tenantId", NEW."contactId", NEW."updatedAt");
    IF latest."campaignId" IS NOT NULL THEN
      INSERT INTO "CampaignConversion" (
        "id", "tenantId", "campaignId", "touchId", "contactId", "leadId", "conversionType", "valueCents", "eventKey", "occurredAt"
      ) VALUES (
        'cc_sale_' || md5(NEW."id"), NEW."tenantId", latest."campaignId", latest."touchId", NEW."contactId", NEW."id",
        'sale_won', COALESCE(NEW."valueCents", 0), 'sale_won:' || NEW."id", NEW."updatedAt"
      ) ON CONFLICT ("eventKey") DO NOTHING;
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      IF inserted_count = 1 THEN
        UPDATE "Campaign"
        SET "conversionCount" = "conversionCount" + 1,
            "attributedRevenueCents" = "attributedRevenueCents" + COALESCE(NEW."valueCents", 0)
        WHERE "id" = latest."campaignId";
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Lead_campaign_attribution_insert" ON "Lead";
CREATE TRIGGER "Lead_campaign_attribution_insert"
AFTER INSERT ON "Lead"
FOR EACH ROW EXECUTE FUNCTION denago_record_lead_campaign_conversion();
DROP TRIGGER IF EXISTS "Lead_campaign_attribution_won" ON "Lead";
CREATE TRIGGER "Lead_campaign_attribution_won"
AFTER UPDATE OF "status" ON "Lead"
FOR EACH ROW EXECUTE FUNCTION denago_record_lead_campaign_conversion();

CREATE OR REPLACE FUNCTION denago_record_quote_campaign_conversion()
RETURNS trigger AS $$
DECLARE
  latest RECORD;
  quote_value INTEGER := 0;
  inserted_count INTEGER;
  conversion_name TEXT;
BEGIN
  IF NEW."contactId" IS NULL OR NEW."status" NOT IN ('sent', 'accepted') OR OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;
  SELECT * INTO latest FROM denago_latest_campaign_touch(NEW."tenantId", NEW."contactId", NEW."updatedAt");
  IF latest."campaignId" IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(ROUND(i."qty" * i."unitPriceCents" * (1 - i."discountPct" / 100.0))) FILTER (WHERE i."selected" = true), 0)::INTEGER
    + COALESCE((SELECT SUM(f."amountCents") FROM "QuoteFee" f WHERE f."quoteId" = NEW."id"), 0)::INTEGER
  INTO quote_value
  FROM "QuoteItem" i WHERE i."quoteId" = NEW."id";

  conversion_name := CASE WHEN NEW."status" = 'accepted' THEN 'quote_accepted' ELSE 'quote_sent' END;
  INSERT INTO "CampaignConversion" (
    "id", "tenantId", "campaignId", "touchId", "contactId", "leadId", "quoteId", "conversionType", "valueCents", "eventKey", "occurredAt"
  ) VALUES (
    'cc_quote_' || md5(NEW."id" || ':' || conversion_name), NEW."tenantId", latest."campaignId", latest."touchId",
    NEW."contactId", NEW."leadId", NEW."id", conversion_name, quote_value,
    conversion_name || ':' || NEW."id", NEW."updatedAt"
  ) ON CONFLICT ("eventKey") DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 1 THEN
    UPDATE "Campaign" SET "conversionCount" = "conversionCount" + 1 WHERE "id" = latest."campaignId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Quote_campaign_attribution" ON "Quote";
CREATE TRIGGER "Quote_campaign_attribution"
AFTER UPDATE OF "status" ON "Quote"
FOR EACH ROW EXECUTE FUNCTION denago_record_quote_campaign_conversion();
