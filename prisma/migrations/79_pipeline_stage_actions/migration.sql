-- Explicit, configurable behaviour when a lead enters a pipeline stage.
-- Existing installations used a stage-name convention. Backfill at most one OPEN
-- matching stage per tenant/pipeline, deterministically, and enforce the invariant.

ALTER TABLE "PipelineStage"
  ADD COLUMN IF NOT EXISTS "entryAction" TEXT;

ALTER TABLE "PipelineStage"
  DROP CONSTRAINT IF EXISTS "PipelineStage_entryAction_check";

ALTER TABLE "PipelineStage"
  ADD CONSTRAINT "PipelineStage_entryAction_check"
  CHECK ("entryAction" IS NULL OR "entryAction" IN ('book_test_drive'))
  NOT VALID;

ALTER TABLE "PipelineStage"
  VALIDATE CONSTRAINT "PipelineStage_entryAction_check";

-- Closed stages cannot collect an entry action. Repair any value left by an older
-- interrupted attempt before applying uniqueness.
UPDATE "PipelineStage"
SET "entryAction" = NULL
WHERE COALESCE("isClosed", false) = true
  AND "entryAction" IS NOT NULL;

-- Repair duplicate values left by an interrupted/older attempt. Keep the earliest
-- stage in order for each tenant/pipeline/action namespace. NULL tenantId remains
-- its own legacy namespace while enforcement is dormant.
WITH ranked_existing AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId", "pipelineId", "entryAction"
      ORDER BY "order" ASC, "id" ASC
    ) AS rn
  FROM "PipelineStage"
  WHERE "entryAction" IS NOT NULL
)
UPDATE "PipelineStage" AS stage
SET "entryAction" = NULL
FROM ranked_existing AS ranked
WHERE stage."id" = ranked."id"
  AND ranked.rn > 1;

-- Preserve the old behaviour without assigning the action to every stage whose
-- name contains "test". A tenant/pipeline that already has a configured action is
-- left unchanged; otherwise the earliest open matching stage wins.
WITH ranked_candidates AS (
  SELECT
    candidate."id",
    ROW_NUMBER() OVER (
      PARTITION BY candidate."tenantId", candidate."pipelineId"
      ORDER BY candidate."order" ASC, candidate."id" ASC
    ) AS rn
  FROM "PipelineStage" AS candidate
  WHERE candidate."entryAction" IS NULL
    AND candidate."name" ILIKE '%test%'
    AND COALESCE(candidate."isClosed", false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM "PipelineStage" AS configured
      WHERE configured."pipelineId" = candidate."pipelineId"
        AND configured."tenantId" IS NOT DISTINCT FROM candidate."tenantId"
        AND configured."entryAction" IS NOT NULL
    )
)
UPDATE "PipelineStage" AS stage
SET "entryAction" = 'book_test_drive'
FROM ranked_candidates AS ranked
WHERE stage."id" = ranked."id"
  AND ranked.rn = 1;

DROP INDEX IF EXISTS "PipelineStage_pipeline_entryAction_key";

CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_tenant_pipeline_entryAction_key"
  ON "PipelineStage" ("tenantId", "pipelineId", "entryAction")
  WHERE "tenantId" IS NOT NULL AND "entryAction" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_legacy_pipeline_entryAction_key"
  ON "PipelineStage" ("pipelineId", "entryAction")
  WHERE "tenantId" IS NULL AND "entryAction" IS NOT NULL;
