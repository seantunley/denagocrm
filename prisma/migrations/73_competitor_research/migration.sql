-- Competitor intelligence, research layer: AI-authored briefs + research cadence.
-- Additive.

ALTER TABLE "Competitor" ADD COLUMN "lastResearchedAt" TIMESTAMP(3);

CREATE TABLE "CompetitorBrief" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'research',
    "headline" TEXT,
    "body" TEXT NOT NULL,
    "citations" JSONB,
    "model" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorBrief_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompetitorBrief_competitorId_createdAt_idx" ON "CompetitorBrief"("competitorId", "createdAt");

ALTER TABLE "CompetitorBrief" ADD CONSTRAINT "CompetitorBrief_competitorId_fkey"
    FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
