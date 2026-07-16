-- Competitor intelligence: CRM-native monitoring of public competitor pages.
-- Additive.

CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "description" TEXT,
    "tier" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Competitor_status_name_idx" ON "Competitor"("status", "name");

CREATE TABLE "CompetitorSource" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'page',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastChangedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorSource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompetitorSource_competitorId_idx" ON "CompetitorSource"("competitorId");
CREATE INDEX "CompetitorSource_active_lastCheckedAt_idx" ON "CompetitorSource"("active", "lastCheckedAt");

CREATE TABLE "CompetitorSnapshot" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "title" TEXT,
    "cleanText" TEXT NOT NULL,
    "rawRef" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompetitorSnapshot_sourceId_fetchedAt_idx" ON "CompetitorSnapshot"("sourceId", "fetchedAt");

CREATE TABLE "CompetitorChange" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "prevSnapshotId" TEXT,
    "snapshotId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "materiality" TEXT NOT NULL DEFAULT 'minor',
    "category" TEXT,
    "summary" TEXT,
    "evidenceBefore" TEXT,
    "evidenceAfter" TEXT,
    "aiJson" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompetitorChange_status_createdAt_idx" ON "CompetitorChange"("status", "createdAt");
CREATE INDEX "CompetitorChange_competitorId_createdAt_idx" ON "CompetitorChange"("competitorId", "createdAt");

ALTER TABLE "CompetitorSource" ADD CONSTRAINT "CompetitorSource_competitorId_fkey"
    FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_competitorId_fkey"
    FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "CompetitorSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_competitorId_fkey"
    FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "CompetitorSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
