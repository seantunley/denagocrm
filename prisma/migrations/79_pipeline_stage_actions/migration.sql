-- Explicit, configurable behaviour when a lead enters a pipeline stage.
-- Existing test-drive stages are backfilled to preserve the previous convention.
ALTER TABLE "PipelineStage" ADD COLUMN "entryAction" TEXT;

ALTER TABLE "PipelineStage"
  ADD CONSTRAINT "PipelineStage_entryAction_check"
  CHECK ("entryAction" IS NULL OR "entryAction" IN ('book_test_drive'));

UPDATE "PipelineStage"
SET "entryAction" = 'book_test_drive'
WHERE "name" ILIKE '%test%';
