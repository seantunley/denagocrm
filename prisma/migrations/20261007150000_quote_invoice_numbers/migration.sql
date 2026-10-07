-- A tax invoice gets its OWN number from the workspace's invoice sequence, not
-- the quote number with "INV-" in front (Sean, 2026-10-07). Additive and
-- re-runnable: a nullable column, a per-workspace unique index, and a one-off
-- numbering of the quotes that are already accepted or invoiced.

-- The backfill below reads and writes existing rows of a FORCE-RLS table.
SET app.bypass_rls = 'on';

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "invoiceNumber" INTEGER;

-- One invoice number per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "Quote_tenantId_invoiceNumber_key" ON "Quote"("tenantId", "invoiceNumber");

-- Existing accepted / invoiced quotes, numbered per workspace in the order they
-- became invoices (invoiced, else signed, else created). Each workspace starts
-- at a RANDOM point between 10000 and 99999, not at 1 (Sean: the numbers
-- mustn't give away how many invoices there have been) — or after any number
-- already issued. Only rows still without a number are touched.
-- MATERIALIZED: RANDOM() is drawn once per workspace, not once per row.
WITH starts AS MATERIALIZED (
  SELECT t."tenantId",
         COALESCE((SELECT MAX(x."invoiceNumber") FROM "Quote" x WHERE x."tenantId" IS NOT DISTINCT FROM t."tenantId"),
                  9999 + FLOOR(RANDOM() * 90000)::int) AS before_first
    FROM (SELECT DISTINCT "tenantId" FROM "Quote") t
),
numbered AS (
  SELECT q.id,
         s.before_first
           + ROW_NUMBER() OVER (
               PARTITION BY q."tenantId"
               ORDER BY COALESCE(q."invoicedAt", q."signedAt", q."createdAt"), q."number"
             ) AS n
    FROM "Quote" q
    JOIN starts s ON s."tenantId" IS NOT DISTINCT FROM q."tenantId"
   WHERE q."invoiceNumber" IS NULL
     AND q."deletedAt" IS NULL
     AND (q."status" = 'accepted' OR q."invoicedAt" IS NOT NULL)
)
UPDATE "Quote" SET "invoiceNumber" = numbered.n
  FROM numbered
 WHERE "Quote".id = numbered.id;

RESET app.bypass_rls;
