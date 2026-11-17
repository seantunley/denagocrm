-- Finance per QUOTE (Sean, 2026-11-16): "If I am changing the finance status on Q-1045, it's changing the status on
-- Q-1044". A deal can carry several quotes; each gets its own finance record, and only the accepted one goes ahead.
-- Re-runnable.

ALTER TABLE "DealFinance" ADD COLUMN IF NOT EXISTS "quoteId" TEXT;

-- Each existing record goes to its deal's newest quote that is still in play (else its newest quote at all).
-- DealFinance and Quote FORCE row-level security: without lifting it for this session a role lacking BYPASSRLS
-- would update nothing and still be recorded as applied.
SET app.bypass_rls = 'on';
UPDATE "DealFinance" f
SET "quoteId" = (
  SELECT q."id" FROM "Quote" q
  WHERE q."tenantId" = f."tenantId" AND q."leadId" = f."leadId" AND q."deletedAt" IS NULL
  ORDER BY (q."supersededAt" IS NULL AND q."status" NOT IN ('cancelled', 'declined')) DESC, q."createdAt" DESC
  LIMIT 1
)
WHERE f."quoteId" IS NULL;

-- One per quote now; several per deal.
DROP INDEX IF EXISTS "DealFinance_tenantId_leadId_key";
CREATE INDEX IF NOT EXISTS "DealFinance_tenantId_leadId_idx" ON "DealFinance"("tenantId", "leadId");
CREATE UNIQUE INDEX IF NOT EXISTS "DealFinance_tenantId_quoteId_key" ON "DealFinance"("tenantId", "quoteId");

-- Within one workspace only, like the lead and the finance house.
DO $$ BEGIN
  ALTER TABLE "DealFinance" ADD CONSTRAINT "DealFinance_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
