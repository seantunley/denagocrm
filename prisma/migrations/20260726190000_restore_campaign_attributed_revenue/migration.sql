-- Restore Campaign."attributedRevenueCents" — the attribution rollup column that was
-- dropped when marketing PRs #202–#216 were consolidated into #222. It is referenced by
-- the marketing overview/calendar queries (src/lib/marketingOverview.ts) AND written by
-- the conversion-attribution triggers (20260724220000_marketing_attribution). Its absence
-- 500s every marketing page and, worse, aborts any Lead/Quote transition to "won" that
-- resolves to a campaign touch (the AFTER trigger errors on the missing column and rolls
-- back the originating statement). Additive + idempotent.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "attributedRevenueCents" INTEGER NOT NULL DEFAULT 0;

-- Backfill so historical attributed revenue is correct (the trigger only maintains it
-- going forward). Mirrors the trigger's semantics exactly: per-campaign sum of the
-- valueCents on 'sale_won' conversions.
UPDATE "Campaign" c
SET "attributedRevenueCents" = COALESCE(sub.total, 0)
FROM (
  SELECT "campaignId", SUM("valueCents")::int AS total
  FROM "CampaignConversion"
  WHERE "conversionType" = 'sale_won'
  GROUP BY "campaignId"
) sub
WHERE c."id" = sub."campaignId";
