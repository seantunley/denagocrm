-- Widen the stage-action vocabulary by one: 'attach_quote'.
--
-- The third remedy, and the first one added after the registry existed — so it is
-- the change that tests whether "adding a remedy is cheap and consistent" was
-- true. It is this migration, an entry in PIPELINE_STAGE_ACTIONS
-- (src/lib/pipelineStageActions.ts), an entry in STAGE_REMEDIES
-- (src/lib/stageRemedies.ts) with its effect declared, and the dialog behind it.
--
-- The CHECK is the database's half of that vocabulary and is enforced ONLY here —
-- Prisma's DSL has no equivalent — so a value added to the tuple without this
-- migration fails at the INSERT rather than at the type check.
--
-- ADDITIVE AND INERT: this widens what is ALLOWED and changes no row. No stage
-- carries 'attach_quote' until somebody chooses it in Settings → Pipelines, and
-- the two existing values mean exactly what they meant before.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode.
--
-- The DROP comes first because this WIDENS a constraint that already exists — a
-- bare "add if absent" would find the old one in place and skip, leaving the
-- narrow vocabulary behind. Dropping and re-adding under a pg_constraint guard is
-- reentrant in both directions: after a full apply the guard finds the new
-- constraint and does nothing, and after a partial one the DROP clears whatever
-- is there and the guard re-adds it.
--
-- The guard matches on 'attach_quote' specifically rather than on the whole
-- definition, so it is the NEW value that decides whether the work is already
-- done. Matching the full text would make this migration re-run on any unrelated
-- reformatting of the constraint.
--
-- NOT VALID then VALIDATE, matching migrations 79 and 20260813160000: the two-step
-- takes a weaker lock than a validating ADD, and existing rows can only hold NULL,
-- 'book_test_drive' or 'link_contact', all of which the new constraint permits.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PipelineStage_entryAction_check'
      AND pg_get_constraintdef(oid) LIKE '%attach_quote%'
  ) THEN
    ALTER TABLE "PipelineStage"
      DROP CONSTRAINT IF EXISTS "PipelineStage_entryAction_check";

    ALTER TABLE "PipelineStage"
      ADD CONSTRAINT "PipelineStage_entryAction_check"
      CHECK (
        "entryAction" IS NULL
        OR "entryAction" IN ('book_test_drive', 'link_contact', 'attach_quote')
      )
      NOT VALID;

    ALTER TABLE "PipelineStage"
      VALIDATE CONSTRAINT "PipelineStage_entryAction_check";
  END IF;
END $$;
