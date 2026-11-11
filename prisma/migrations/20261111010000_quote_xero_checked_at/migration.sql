-- Additive: when "Refresh all from Xero" last tried each invoice (review of #1071),
-- so repeated presses advance through every open invoice. Reentrant: the
-- migration runner has no transaction.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroCheckedAt" TIMESTAMP(3);
