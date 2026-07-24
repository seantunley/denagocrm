-- Marketing phase 1: additive campaign lifecycle, immutable versions and event ledger.
-- Replay-safe for scripts/apply-migrations.mjs. Existing tracking tokens and sent
-- recipient rows are retained; no campaign or recipient is deleted.

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "preheader" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "audienceSnapshot" JSONB;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "segmentId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "objective" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "offer" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "landingPageUrl" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "primaryCtaLabel" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "primaryCtaUrl" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "internalNotes" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "budgetCents" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "targetLeadCount" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "targetRevenueCents" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "successMetric" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "timezone" TEXT DEFAULT 'Africa/Johannesburg';
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "approvedById" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "submittedForReviewAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "reviewRequestedById" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "changesRequestedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "suppressedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "unsubscribeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "conversionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "revenueCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "suppressionReason" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "providerStatus" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "unsubscribedAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "convertedAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "conversionValueCents" INTEGER NOT NULL DEFAULT 0;

-- Historical lifecycle mapping from the original draft/queued/sending/sent model.
UPDATE "Campaign"
SET "status" = CASE
  WHEN "status" = 'sent' AND COALESCE("failedCount", 0) = 0 THEN 'completed'
  WHEN "status" = 'sent' AND COALESCE("failedCount", 0) > 0 THEN 'completed_with_errors'
  ELSE "status"
END,
"completedAt" = CASE
  WHEN "status" = 'sent' THEN COALESCE("completedAt", "sentAt", "createdAt")
  ELSE "completedAt"
END
WHERE "status" = 'sent';

UPDATE "CampaignRecipient" SET "status" = 'failed_permanent' WHERE "status" = 'failed';
ALTER TABLE "CampaignRecipient" ALTER COLUMN "status" SET DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS "CampaignVersion" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "campaignId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "reason" TEXT,
  "createdById" TEXT,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CampaignEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "campaignId" TEXT NOT NULL,
  "campaignRecipientId" TEXT,
  "contactId" TEXT,
  "type" TEXT NOT NULL,
  "url" TEXT,
  "providerMessageId" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'CampaignVersion_campaignId_fkey'
      AND conrelid = '"CampaignVersion"'::regclass
  ) THEN
    ALTER TABLE "CampaignVersion"
      ADD CONSTRAINT "CampaignVersion_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'CampaignEvent_campaignId_fkey'
      AND conrelid = '"CampaignEvent"'::regclass
  ) THEN
    ALTER TABLE "CampaignEvent"
      ADD CONSTRAINT "CampaignEvent_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignVersion_campaignId_version_key"
  ON "CampaignVersion"("campaignId", "version");
CREATE INDEX IF NOT EXISTS "CampaignVersion_campaign_created_idx"
  ON "CampaignVersion"("campaignId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "CampaignVersion_tenantId_idx" ON "CampaignVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "CampaignEvent_campaign_type_time_idx"
  ON "CampaignEvent"("campaignId", "type", "occurredAt");
CREATE INDEX IF NOT EXISTS "CampaignEvent_recipient_time_idx"
  ON "CampaignEvent"("campaignRecipientId", "occurredAt");
CREATE INDEX IF NOT EXISTS "CampaignEvent_contact_time_idx"
  ON "CampaignEvent"("contactId", "occurredAt");
CREATE INDEX IF NOT EXISTS "CampaignEvent_tenantId_idx" ON "CampaignEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "Campaign_status_scheduled_idx" ON "Campaign"("status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "Campaign_owner_status_idx" ON "Campaign"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaign_status_idx"
  ON "CampaignRecipient"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_providerMessageId_idx"
  ON "CampaignRecipient"("providerMessageId");

-- Create one immutable historical snapshot where none exists. IDs are deterministic
-- so replaying the migration is harmless.
INSERT INTO "CampaignVersion" (
  "id", "tenantId", "campaignId", "version", "snapshot", "reason",
  "createdById", "createdAt"
)
SELECT
  'cv_legacy_' || md5(c."id"),
  c."tenantId",
  c."id",
  1,
  jsonb_build_object(
    'name', c."name",
    'channel', c."channel",
    'subject', c."subject",
    'preheader', c."preheader",
    'body', c."body",
    'htmlBody', c."htmlBody",
    'audience', c."audience",
    'audienceSnapshot', c."audienceSnapshot",
    'segmentId', c."segmentId",
    'objective', c."objective",
    'offer', c."offer",
    'productId', c."productId",
    'landingPageUrl', c."landingPageUrl",
    'primaryCtaLabel', c."primaryCtaLabel",
    'primaryCtaUrl', c."primaryCtaUrl",
    'statusAtSnapshot', c."status",
    'recipientCount', c."recipientCount"
  ),
  'Historical campaign backfill',
  c."createdById",
  c."createdAt"
FROM "Campaign" c
WHERE NOT EXISTS (
  SELECT 1 FROM "CampaignVersion" v WHERE v."campaignId" = c."id"
)
ON CONFLICT ("campaignId", "version") DO NOTHING;

-- Granular marketing permissions. Existing roles with campaigns.manage inherit the
-- new keys so the rollout remains behaviour-preserving for current staff.
INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('campaigns.create', 'Create campaign drafts', 'Marketing'),
  ('campaigns.edit', 'Edit campaign drafts and requested changes', 'Marketing'),
  ('campaigns.review', 'Review campaigns and request changes', 'Marketing'),
  ('campaigns.approve', 'Approve campaigns for launch', 'Marketing'),
  ('campaigns.schedule', 'Schedule approved campaigns', 'Marketing'),
  ('campaigns.send', 'Launch approved campaigns', 'Marketing'),
  ('campaigns.pause', 'Pause queued or sending campaigns', 'Marketing'),
  ('campaigns.cancel', 'Cancel scheduled or in-flight campaigns', 'Marketing'),
  ('campaigns.retry', 'Retry eligible campaign delivery failures', 'Marketing'),
  ('campaigns.archive', 'Archive completed or cancelled campaigns', 'Marketing'),
  ('campaigns.manage_audiences', 'Create and manage campaign audiences', 'Marketing'),
  ('campaigns.manage_templates', 'Create and manage marketing templates', 'Marketing'),
  ('campaigns.view_analytics', 'View campaign delivery and attribution analytics', 'Marketing')
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category";

INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT legacy."roleId", granular."permissionKey"
FROM "RolePermission" legacy
CROSS JOIN (VALUES
  ('campaigns.create'), ('campaigns.edit'), ('campaigns.review'),
  ('campaigns.approve'), ('campaigns.schedule'), ('campaigns.send'),
  ('campaigns.pause'), ('campaigns.cancel'), ('campaigns.retry'),
  ('campaigns.archive'), ('campaigns.manage_audiences'),
  ('campaigns.manage_templates'), ('campaigns.view_analytics')
) AS granular("permissionKey")
WHERE legacy."permissionKey" = 'campaigns.manage'
ON CONFLICT DO NOTHING;
