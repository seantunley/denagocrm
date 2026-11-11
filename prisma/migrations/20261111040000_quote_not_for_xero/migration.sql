-- Additive and reentrant (the migration runner has no transaction).
-- Sean, 2026-11-11: historical invoices "were processed in a different way… Their
-- invoices do not belong in Xero" — marked one by one, never offered to Xero.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroExcludedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroExcludedByName" TEXT;
