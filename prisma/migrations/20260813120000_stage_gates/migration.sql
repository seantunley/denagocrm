-- Stage entry and exit criteria.
--
-- Four columns on PipelineStage, no new table. That is a TENANCY decision before
-- it is a modelling one: a column on this table inherits the row's tenantId, its
-- index, its unique (tenantId, id), the composite FK Lead(tenantId, stageId), and
-- the RLS policy created by 20260727130000_rls_enforce. A PipelineStageCriterion
-- table would have to re-earn every one of those, and the production audit found
-- 27 tables with NO RLS for exactly that reason — they were added after the
-- enforce migration and nobody wrote the policy block. A JSON column cannot
-- become the 28th.
--
-- INERT ON DEPLOY, by construction rather than by intention:
--   * both criteria columns default to NULL, and evaluateConditions() returns
--     true for a null or empty group, so a NULL gate is structurally incapable
--     of blocking a move;
--   * both mode columns default to 'off', which the evaluator skips before it
--     even looks at the criteria.
-- So every existing stage on every existing board behaves exactly as it did
-- before this migration ran. There is no backfill and nothing to undo.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode. Every statement is IF NOT EXISTS.

ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "entryCriteria" JSONB;
ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "exitCriteria"  JSONB;

ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "entryGateMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "exitGateMode"  TEXT NOT NULL DEFAULT 'off';

-- The mode vocabulary, enforced by the database as well as by the parser.
--
-- The app's parseStageGateMode() already maps an unknown value to 'off' — it
-- fails OPEN deliberately, because an unreadable severity must never become a
-- block. That is the right behaviour for a READ; it is the wrong behaviour to
-- rely on for a WRITE, because it would let a typo persist silently and then
-- quietly stop enforcing a rule the author believes is on. The constraint makes
-- a bad write fail loudly at the point it happens.
--
-- Mirrors the CHECK constraints migration 52 and 79 put on closedStatus and
-- entryAction, which are likewise enforced only by the database because Prisma's
-- DSL has no equivalent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PipelineStage_entryGateMode_check'
  ) THEN
    ALTER TABLE "PipelineStage"
      ADD CONSTRAINT "PipelineStage_entryGateMode_check"
      CHECK ("entryGateMode" IN ('off', 'warn', 'reason', 'block'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PipelineStage_exitGateMode_check'
  ) THEN
    ALTER TABLE "PipelineStage"
      ADD CONSTRAINT "PipelineStage_exitGateMode_check"
      CHECK ("exitGateMode" IN ('off', 'warn', 'reason', 'block'));
  END IF;
END $$;
