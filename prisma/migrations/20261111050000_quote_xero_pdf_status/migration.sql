-- Additive and reentrant (the migration runner has no transaction).
-- Which of Xero's states the filed Xero PDF shows: the hourly automatic payments
-- check moves an invoice's status on without filing a PDF, and a person's next
-- Refresh files the newer one. Null (every invoice before this) = refile once.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroPdfStatus" TEXT;
