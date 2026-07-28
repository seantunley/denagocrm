-- Align four column attributes that drifted from the declared schema.
--
-- Found by diffing production against prisma/schema.prisma while reconciling the
-- migration ledger. None of these is urgent; they are corrected so that the
-- integrity check reports a clean schema and a genuine difference stands out in
-- future instead of being lost among known-noisy lines.
--
-- Every statement here WIDENS or re-defaults. Nothing drops data, nothing adds a
-- constraint that existing rows could violate, and each was checked against
-- production data first (1 StockUnit row, 1 Survey row).
--
-- DELIBERATELY NOT "FIXED" — two diff lines that look like drift and are not:
--
--   * StockUnit_stockNumber_key. `prisma migrate diff` reports this unique index
--     as missing. It is not: production has it as a PARTIAL index,
--       CREATE UNIQUE INDEX ... ("stockNumber") WHERE ("stockNumber" IS NOT NULL)
--     which is what migrations 50/52 created on purpose and what the schema
--     comment on StockUnit describes. Prisma cannot model partial indexes, so it
--     only recognises the plain form and reports the real one as absent. Creating
--     the plain index would replace a deliberate partial index with one that also
--     constrains soft-deleted rows.
--
--   * AppSetting.id default. The diff asks to SET DEFAULT gen_random_uuid()::text;
--     production already has (gen_random_uuid())::text. The difference is
--     parenthesisation in the stored expression, not behaviour — verified by
--     inserting a row with no id inside a rolled-back transaction.
--
-- Likewise the ~311 DROP CONSTRAINT lines in that diff are the composite tenant
-- foreign keys from the enforcement migrations. Prisma does not model composite
-- FKs, so it proposes dropping every one. They are load-bearing; the integrity
-- check already ignores DROP statements for exactly this reason.

-- 1. StockUnit.salePriceCents — schema declares `Int?` (nullable, no default),
--    production had NOT NULL DEFAULT 0. The schema is authoritative: a stock unit
--    genuinely may have no sale price yet, and code typed against `Int | null`
--    would have failed on write. Widening only; the existing row keeps its 0.
ALTER TABLE "StockUnit" ALTER COLUMN "salePriceCents" DROP NOT NULL;
ALTER TABLE "StockUnit" ALTER COLUMN "salePriceCents" DROP DEFAULT;

-- 2. CustomFieldDef/CustomFieldValue.updatedAt — schema uses Prisma's @updatedAt,
--    which always supplies the value from the application. The leftover database
--    DEFAULT CURRENT_TIMESTAMP is never reached and only obscures where the value
--    comes from. Columns stay NOT NULL.
ALTER TABLE "CustomFieldDef" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "CustomFieldValue" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- 3. Survey.active — schema declares @default(false); production defaulted to
--    true. Prisma always sends the value so no survey was affected, but a survey
--    created by raw SQL would have gone live by default, which is the wrong way
--    round for a publishing workflow.
ALTER TABLE "Survey" ALTER COLUMN "active" SET DEFAULT false;
