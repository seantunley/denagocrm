-- Additive and reentrant (the migration runner has no transaction). Review of #1071:
-- was the deposit CREATED from a Xero payment, or recorded by hand and only matched
-- to one? A Xero organisation switch clears the first and keeps the second.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroDepositCreated" BOOLEAN NOT NULL DEFAULT false;
