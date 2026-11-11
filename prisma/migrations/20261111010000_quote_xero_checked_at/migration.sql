-- Additive: when "Refresh all from Xero" last tried each invoice (review of #1071),
-- so repeated presses advance through every open invoice.
ALTER TABLE "Quote" ADD COLUMN "xeroCheckedAt" TIMESTAMP(3);
