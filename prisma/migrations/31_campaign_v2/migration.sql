-- Campaign v2: HTML body, per-recipient queue + open/click tracking, segments.
ALTER TABLE "Campaign" ADD COLUMN "htmlBody" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "clickCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickedAt" TIMESTAMP(3),
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignRecipient_token_key" ON "CampaignRecipient"("token");
CREATE INDEX "CampaignRecipient_campaignId_idx" ON "CampaignRecipient"("campaignId");
CREATE INDEX "CampaignRecipient_status_idx" ON "CampaignRecipient"("status");
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);
