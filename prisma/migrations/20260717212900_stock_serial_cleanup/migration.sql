-- Normalise existing stock serials before the operations-platform migration
-- adds the active unique serial index. The oldest active record keeps a
-- duplicated identifier; later duplicates are flagged in notes and cleared so
-- production migration cannot fail on legacy data quality.

UPDATE "StockUnit"
SET "serial" = UPPER(REGEXP_REPLACE(TRIM("serial"), '\s+', '', 'g'))
WHERE "serial" IS NOT NULL AND TRIM("serial") <> '';

WITH ranked AS (
  SELECT
    "id",
    "serial",
    ROW_NUMBER() OVER (
      PARTITION BY UPPER("serial")
      ORDER BY COALESCE("arrivedAt", "createdAt") ASC, "id" ASC
    ) AS duplicate_rank
  FROM "StockUnit"
  WHERE "serial" IS NOT NULL
    AND "deletedAt" IS NULL
), duplicates AS (
  SELECT "id", "serial"
  FROM ranked
  WHERE duplicate_rank > 1
)
UPDATE "StockUnit" AS unit
SET
  "notes" = CONCAT_WS(
    E'\n',
    NULLIF(unit."notes", ''),
    'Migration warning: duplicate active serial ' || duplicates."serial" || ' was cleared; verify the physical identifier.'
  ),
  "serial" = NULL
FROM duplicates
WHERE unit."id" = duplicates."id";
