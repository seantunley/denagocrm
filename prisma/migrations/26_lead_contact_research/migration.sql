-- Dedicated storage for AI research (moved off the Communication timeline).
ALTER TABLE "Lead" ADD COLUMN "research" TEXT;
ALTER TABLE "Lead" ADD COLUMN "researchedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "research" TEXT;
ALTER TABLE "Contact" ADD COLUMN "researchedAt" TIMESTAMP(3);
