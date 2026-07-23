-- Explicit, configurable behaviour when a lead enters a pipeline stage.
-- Existing installations used a stage-name convention. Backfill at most one OPEN
-- matching stage per pipeline, deterministically, and enforce the invariant in the DB.

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

-- Repair any duplicate values left by an interrupted/older attempt before adding
-- the unique index. Keep the earliest stage in pipeline order.
WITH ranked_existing AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "pipelineId", "entryAction"
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
-- name contains "test". Pipelines that already have a configured action are left
-- unchanged; otherwise the earliest open matching stage wins.
WITH ranked_candidates AS (
  SELECT
    candidate."id",
    ROW_NUMBER() OVER (
      PARTITION BY candidate."pipelineId"
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
        AND configured."entryAction" IS NOT NULL
    )
)
UPDATE "PipelineStage" AS stage
SET "entryAction" = 'book_test_drive'
FROM ranked_candidates AS ranked
WHERE stage."id" = ranked."id"
  AND ranked.rn = 1;

CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_pipeline_entryAction_key"
  ON "PipelineStage" ("pipelineId", "entryAction")
  WHERE "entryAction" IS NOT NULL;
