-- Multi-currency module (2026-11-06): the currency a lead's value and a quote's amounts are in.
-- Additive and re-runnable. NULL means the workspace's base currency, so every existing row reads
-- exactly as before, and nothing writes a value unless the `multicurrency` module is on.
-- No new table: both columns sit on rows already covered by tenant RLS.

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "currency" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "currency" TEXT;
