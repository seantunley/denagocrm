ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "ruleTree" JSONB;
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "lastCalculatedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "lastCalculatedAt" TIMESTAMP(3);
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'marketing_email';
ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "plainTextBody" TEXT;
ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "EmailTemplate" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "MarketingAudienceVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "segmentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "ruleTree" JSONB NOT NULL,
  "explanation" TEXT,
  "createdById" TEXT,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingAudienceVersion_segment_version_key" ON "MarketingAudienceVersion"("segmentId", "version");
CREATE INDEX IF NOT EXISTS "MarketingAudienceVersion_tenantId_idx" ON "MarketingAudienceVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "MarketingAudienceVersion_segment_created_idx" ON "MarketingAudienceVersion"("segmentId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS "MarketingTemplateVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "reason" TEXT,
  "createdById" TEXT,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingTemplateVersion_template_version_key" ON "MarketingTemplateVersion"("templateId", "version");
CREATE INDEX IF NOT EXISTS "MarketingTemplateVersion_tenantId_idx" ON "MarketingTemplateVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "MarketingTemplateVersion_template_created_idx" ON "MarketingTemplateVersion"("templateId", "createdAt" DESC);

-- "criteria" is a free-form historical string column — some rows predate
-- strict JSON and are not valid JSON at all. A bare "criteria"::jsonb cast
-- throws on the first such row and aborts this entire migration (which also
-- creates the MarketingAudienceVersion/MarketingTemplateVersion tables above,
-- so a crash here blocks every later migration behind it too). This function
-- never throws: valid JSON parses as before, anything else backfills to a
-- distinct, explicitly-flagged marker instead of silently becoming a
-- same-shaped-but-wrong rule (marketingAudiences.ts's matchesNode treats
-- invalidHistoricalCriteria as "exclude until reviewed", not "match everyone").
CREATE OR REPLACE FUNCTION denago_safe_jsonb(input text)
RETURNS jsonb AS $$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "Segment"
SET "ruleTree" = jsonb_build_object(
  'operator', 'AND',
  'rules', CASE
    WHEN "criteria" IS NULL OR "criteria" = '' THEN '[]'::jsonb
    WHEN denago_safe_jsonb("criteria") IS NOT NULL THEN jsonb_build_array(jsonb_build_object('legacyCriteria', denago_safe_jsonb("criteria")))
    ELSE jsonb_build_array(jsonb_build_object('legacyCriteria', jsonb_build_object('invalidHistoricalCriteria', true, 'raw', "criteria")))
  END,
  'exclusions', '[]'::jsonb
)
WHERE "ruleTree" IS NULL;

INSERT INTO "MarketingAudienceVersion" ("id", "tenantId", "segmentId", "version", "ruleTree", "explanation", "createdAt")
SELECT 'mav_' || md5(s."id"), s."tenantId", s."id", 1, s."ruleTree", 'Historical audience backfill', s."createdAt"
FROM "Segment" s
WHERE NOT EXISTS (SELECT 1 FROM "MarketingAudienceVersion" v WHERE v."segmentId" = s."id")
ON CONFLICT DO NOTHING;

INSERT INTO "MarketingTemplateVersion" ("id", "tenantId", "templateId", "version", "snapshot", "reason", "createdAt")
SELECT 'mtv_' || md5(t."id"), t."tenantId", t."id", 1,
  jsonb_build_object('name', t."name", 'subject', t."subject", 'body', t."body", 'category', t."category", 'status', t."status"),
  'Historical template backfill', t."createdAt"
FROM "EmailTemplate" t
WHERE NOT EXISTS (SELECT 1 FROM "MarketingTemplateVersion" v WHERE v."templateId" = t."id")
ON CONFLICT DO NOTHING;
