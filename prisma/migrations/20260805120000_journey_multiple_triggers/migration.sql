-- A published journey version may listen for SEVERAL triggers, each with its own
-- filter, instead of exactly one.
--
--   "trigger"       TEXT   →  "triggers" JSONB
--   "triggerConfig" JSONB  ↗   [{ "id"?, "type", "config" }]
--
-- Until now "enrol when a lead is created OR when one is imported" meant
-- building two identical journeys and keeping them in step by hand.
--
-- ── IN-FLIGHT RUNS ─────────────────────────────────────────────────────────
--
-- A published JourneyVersion is immutable and runs are pinned to it: a run
-- parked on a `wait` can hold "journeyVersionId" for up to 30 days before a
-- different process picks it up. So the question this migration has to answer
-- is what a parked run reads when it resumes.
--
-- It reads "definition", "entryConditions" and "version". It does NOT read the
-- trigger — enrolment is over by the time a run exists, and nothing in
-- processOneRun consults what let the person in. (The one exception is not an
-- exception: a `wait_for_trigger` step watches event types named in its own
-- step config, inside "definition", which this migration does not touch.)
--
-- So no in-flight run is disturbed. Not "unlikely to be" — the columns being
-- replaced are not on the resume path at all. Every byte a run does read is
-- left exactly as it was: nothing here rewrites "definition",
-- "entryConditions", "version", "state" or "publishedAt".
--
-- ── LOSSLESSNESS ───────────────────────────────────────────────────────────
--
-- Every existing row has exactly one trigger and one config, and becomes a
-- one-element list holding exactly those two values. A version that enrolled on
-- lead_created still enrols on lead_created and on nothing else; a
-- stage_entered version keeps the stageId that qualified it. No row gains a
-- trigger, loses one, or has one rewritten.
--
-- Backfilled triggers are deliberately left UNNAMED (no "id"). That is not an
-- omission — it is what keeps the scheduler's dedupe keys byte-identical.
-- Those keys embed the trigger id only when one exists, so an anniversary or
-- win-back journey mid-cycle does not see its keys change and re-emit to
-- everybody it has already contacted.
--
-- ── ROLLING BACK ───────────────────────────────────────────────────────────
--
-- The old columns are DROPPED rather than kept alongside, and that is a choice
-- with a cost. Keeping "trigger" as a denormalised copy would leave two places
-- that answer "what does this journey listen for", and a reader left on the old
-- one is a journey that silently stops enrolling — the exact failure this
-- feature must not introduce. Dropping the columns makes that impossible to
-- write: the TypeScript compiler rejects every stale property access and
-- PostgreSQL rejects every stale SQL reference.
--
-- The cost is that redeploying the PREVIOUS build against this database fails.
-- It fails LOUDLY and before serving: scripts/apply-migrations.mjs ends with an
-- integrity check that compares the live database against the deployed schema
-- and blocks the build on a missing column. A schema rollback is a deliberate
-- act; this makes it a blocked build rather than a silent one.
--
-- ── RE-RUNNABILITY ─────────────────────────────────────────────────────────
--
-- The runner applies SQL first and records second, so a crash between the two
-- re-runs this file. Every statement is guarded, and the backfill — which reads
-- columns this file later drops — sits inside a PL/pgSQL block guarded on their
-- presence. PL/pgSQL does not plan a statement until it executes it, so on a
-- second run the block returns immediately rather than failing to resolve a
-- dropped column.

-- Journey, JourneyVersion and JourneyEvent are FORCE ROW LEVEL SECURITY
-- (20260727130000_rls_enforce), which applies to the table owner too. Without
-- the policy's own escape hatch the UPDATE below would match ZERO rows in every
-- tenant, and the SET NOT NULL that follows would then fail — loudly, which is
-- the right outcome, but the bypass is what makes the backfill actually run.
SET app.bypass_rls = 'on';

-- Nullable first. A NOT NULL DEFAULT '[]' would fill unbackfilled rows with
-- "listens for nothing" — a journey that stops enrolling and says nothing about
-- it — so the column is left NULL until the backfill has genuinely written it,
-- and the SET NOT NULL below is what proves it did.
ALTER TABLE "JourneyVersion" ADD COLUMN IF NOT EXISTS "triggers" JSONB;

DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'JourneyVersion'
       AND column_name = 'trigger'
  ) THEN
    EXECUTE $sql$
      UPDATE "JourneyVersion"
         SET "triggers" = jsonb_build_array(
               jsonb_build_object(
                 'type', "trigger",
                 -- "triggerConfig" is nullable in two different ways: SQL NULL
                 -- (never set) and JSON null (Prisma.JsonNull, written by the
                 -- create path whenever the builder sent no config). COALESCE
                 -- only sees the first, so the type is checked explicitly —
                 -- otherwise a version would carry `"config": null` and every
                 -- later `spec.config.stageId` read would throw.
                 'config',
                 CASE
                   WHEN jsonb_typeof(COALESCE("triggerConfig", '{}'::jsonb)) = 'object'
                     THEN COALESCE("triggerConfig", '{}'::jsonb)
                   ELSE '{}'::jsonb
                 END
               )
             )
       WHERE "triggers" IS NULL
    $sql$;
  END IF;
END
$backfill$;

-- The proof that the backfill reached every row. If RLS had swallowed it, or a
-- row had been inserted between the ADD COLUMN and the UPDATE, this fails here
-- rather than leaving a version that quietly enrols nobody.
ALTER TABLE "JourneyVersion" ALTER COLUMN "triggers" SET NOT NULL;

-- The index existed to serve `WHERE "trigger" = … AND "state" = …`. Nothing
-- asks that any more: the enrolment matcher loads the active journeys it needs
-- regardless and chooses in memory, and the pipeline stage badges — the only
-- other caller — already filtered its stageId in JS for the same reason.
DROP INDEX IF EXISTS "JourneyVersion_trigger_state_idx";

ALTER TABLE "JourneyVersion" DROP COLUMN IF EXISTS "trigger";
ALTER TABLE "JourneyVersion" DROP COLUMN IF EXISTS "triggerConfig";

RESET app.bypass_rls;
