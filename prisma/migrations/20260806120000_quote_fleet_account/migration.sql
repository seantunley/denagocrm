-- Quotes issued to a fleet account.
--
-- ONE nullable column and ONE index. Additive and idempotent: ADD COLUMN IF NOT
-- EXISTS and CREATE INDEX IF NOT EXISTS, nothing dropped, renamed, retyped or
-- made NOT NULL, no table created (so no new RLS policy is required — Quote
-- already has one).
--
-- EXPAND-SAFE, which matters here specifically. vercel.json runs
-- `apply-migrations && next build`, so the schema changes while the PREVIOUS
-- deployment is still serving production. A nullable column the old build never
-- selects is invisible to it; it keeps running unchanged until the new build
-- takes over. No backfill, no contract step, no downtime.
--
-- WHY A SEPARATE COLUMN RATHER THAN REUSING contactId. `Quote.contactId` is the
-- PERSON — who signs, who the mail goes to, whose access decides who may open
-- the quote. `fleetId` is the BUSINESS the invoice is addressed to, and whose
-- registration and VAT numbers print on it. A lodge ordering six carts has both
-- facts and they are different facts. Reusing one column would have forced the
-- fleet case to throw one of them away.
--
-- NO FOREIGN KEY, deliberately, matching Contact.fleetId (20260805190000) and
-- Fleet.contactId before it. Resolution is app-layer and tenant-scoped in
-- lib/quoteBillTo.ts, so an id belonging to another workspace fails to RESOLVE —
-- the quote prints its contact instead — rather than being rejected by the
-- database after the row is already written. A foreign key would also have to be
-- validated against the whole existing Quote table while the old build is live.

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "fleetId" TEXT;

-- The fleet record page lists that account's quotes by this column. Without the
-- index that is a sequential scan of the entire quote table per fleet, and the
-- fleet page already runs eight roll-up queries beside it.
--
-- Not CONCURRENTLY: scripts/apply-migrations.mjs submits each migration file to
-- `prisma db execute` as ONE multi-statement script, and Postgres wraps that in
-- an implicit transaction, where CONCURRENTLY cannot run. The lock this takes is
-- on a table of quotes, which is small, and it is taken once.
CREATE INDEX IF NOT EXISTS "Quote_fleetId_idx" ON "Quote"("fleetId");
