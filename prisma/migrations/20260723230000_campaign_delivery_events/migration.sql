-- Provider delivery lifecycle and event ledger for campaign email.
ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "suppressedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deferredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "bouncedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "droppedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "complaintCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "unsubscribeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CampaignRecipient"
  ADD COLUMN IF NOT EXISTS "claimId" TEXT,
  ADD COLUMN IF NOT EXISTS "processingAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "provider" TEXT,
  ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deferredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "droppedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "complainedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "unsubscribedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CampaignRecipient_claimId_idx"
  ON "CampaignRecipient"("claimId");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_providerMessageId_idx"
  ON "CampaignRecipient"("providerMessageId");

CREATE TABLE IF NOT EXISTS "CampaignEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "campaignId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "url" TEXT,
  "reason" TEXT,
  "response" TEXT,
  "smtpCode" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampaignEvent_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CampaignEvent_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignEvent_provider_providerEventId_key"
  ON "CampaignEvent"("provider", "providerEventId");
CREATE INDEX IF NOT EXISTS "CampaignEvent_campaignId_type_occurredAt_idx"
  ON "CampaignEvent"("campaignId", "type", "occurredAt");
CREATE INDEX IF NOT EXISTS "CampaignEvent_recipientId_type_idx"
  ON "CampaignEvent"("recipientId", "type");
CREATE INDEX IF NOT EXISTS "CampaignEvent_tenantId_idx"
  ON "CampaignEvent"("tenantId");

-- AppSetting.key remains globally unique during the staged tenant rollout, so
-- provider credentials need a tenant-keyed table of their own.
CREATE TABLE IF NOT EXISTS "TenantEmailProvider" (
  "tenantId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'sendgrid',
  "apiKey" TEXT,
  "fromAddress" TEXT,
  "unsubscribeEmail" TEXT,
  "webhookPublicKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantEmailProvider_pkey" PRIMARY KEY ("tenantId")
);

-- Preserve any encrypted legacy values during rollout.
INSERT INTO "TenantEmailProvider" (
  "tenantId", "apiKey", "fromAddress", "unsubscribeEmail", "webhookPublicKey"
)
SELECT
  "tenantId",
  MAX(CASE WHEN "key" = 'SENDGRID_API_KEY' THEN "value" END),
  MAX(CASE WHEN "key" = 'SENDGRID_FROM' THEN "value" END),
  MAX(CASE WHEN "key" = 'MARKETING_UNSUBSCRIBE_EMAIL' THEN "value" END),
  MAX(CASE WHEN "key" = 'SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY' THEN "value" END)
FROM "AppSetting"
WHERE "tenantId" IS NOT NULL
  AND "key" IN (
    'SENDGRID_API_KEY',
    'SENDGRID_FROM',
    'MARKETING_UNSUBSCRIBE_EMAIL',
    'SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY'
  )
GROUP BY "tenantId"
ON CONFLICT ("tenantId") DO NOTHING;
