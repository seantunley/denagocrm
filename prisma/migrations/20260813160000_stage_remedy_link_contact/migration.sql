-- Widen the stage-action vocabulary by one: 'link_contact'.
--
-- A stage action is a REMEDY — a rule the stage enforces plus a form that
-- satisfies it. `book_test_drive` was the only one since migration 79, and this
-- is the second, which is what turns a hardcoded special case into a registry.
--
-- The CHECK is the database's half of a vocabulary that also lives in
-- PIPELINE_STAGE_ACTIONS (src/lib/pipelineStageActions.ts) and STAGE_REMEDIES
-- (src/lib/stageRemedies.ts). It is enforced ONLY here — Prisma's DSL has no
-- equivalent — so a value added in the tuple without this migration fails at the
-- INSERT rather than at the type check.
--
-- ADDITIVE AND INERT: this widens what is ALLOWED and changes no row. No stage
-- carries 'link_contact' until somebody chooses it in Settings → Pipelines, and
-- 'book_test_drive' means exactly what it meant before.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode.
--
-- The DROP comes first because this WIDENS a constraint that already exists —
-- a bare "add if absent" would find the old one in place and skip, leaving the
-- narrow vocabulary behind. Dropping and then re-adding under a pg_constraint
-- guard is reentrant in both directions: after a full apply the guard finds the
-- new constraint and does nothing, and after a partial one the DROP clears
-- whatever is there and the guard re-adds it.
--
-- NOT VALID then VALIDATE, matching migration 79: the two-step takes a weaker
-- lock than a validating ADD, and existing rows can only hold NULL or
-- 'book_test_drive', both of which the new constraint already permits.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PipelineStage_entryAction_check'
      AND pg_get_constraintdef(oid) LIKE '%link_contact%'
  ) THEN
    ALTER TABLE "PipelineStage"
      DROP CONSTRAINT IF EXISTS "PipelineStage_entryAction_check";

    ALTER TABLE "PipelineStage"
      ADD CONSTRAINT "PipelineStage_entryAction_check"
      CHECK ("entryAction" IS NULL OR "entryAction" IN ('book_test_drive', 'link_contact'))
      NOT VALID;

    ALTER TABLE "PipelineStage"
      VALIDATE CONSTRAINT "PipelineStage_entryAction_check";
  END IF;
END $$;
