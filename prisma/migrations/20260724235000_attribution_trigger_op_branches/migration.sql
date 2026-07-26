-- Re-apply the attribution conversion trigger with explicit per-operation
-- branches (RETURN NEW in each). This lived as an in-place edit of the
-- 20260724220000 migration, which would fail 'prisma migrate deploy' with a
-- checksum mismatch once that migration had already been applied. Shipped as a
-- forward CREATE OR REPLACE migration instead.

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
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."status" = 'won' AND OLD."status" IS DISTINCT FROM 'won' THEN
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
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
