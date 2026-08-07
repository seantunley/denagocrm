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
-- ── EXPAND ONLY. THE OLD COLUMNS STAY. ─────────────────────────────────────
--
-- This is the EXPAND half of an expand/contract pair, and the drops that used
-- to live at the bottom of this file have been removed deliberately.
--
-- vercel.json runs `apply-migrations && next build`: the schema changes BEFORE
-- the new build exists, and the PREVIOUS deployment carries on serving
-- production traffic throughout — then keeps serving it if the build fails or
-- promotion never happens. That old build queries "trigger" and
-- "triggerConfig". Dropping them here would therefore break the deployment that
-- is live AT THAT MOMENT, and leave it broken for as long as the rollout takes
-- (or permanently, if the rollout fails). Rollback incompatibility was the
-- lesser problem; forward incompatibility with the running app was the real one.
--
-- So both representations exist for one release. "trigger"/"triggerConfig" stay
-- exactly as they are — still NOT NULL, still indexed — and every writer keeps
-- populating them alongside "triggers" (see src/app/actions/journeys.ts), so the
-- old build reads correct data for the whole window and a rollback is a
-- non-event rather than an outage.
--
-- The concern that motivated dropping them — two places answering "what does
-- this journey listen for", with a reader left on the stale one — is real, and
-- is what the CONTRACT migration is for. It drops the columns, the index and
-- the dual-write in a LATER release, once this one is deployed and every row
-- and every writer has been verified. Two temporary representations for one
-- release is a smaller risk than a schema no currently deployed build can use.
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

-- NOTHING IS DROPPED HERE. See the EXPAND ONLY note at the top of this file.
--
-- "trigger", "triggerConfig" and the JourneyVersion_trigger_state_idx index all
-- survive this migration untouched, because the deployment that is serving
-- production while this runs still reads them. The contract migration — a
-- separate, later release — is what removes:
--
--   DROP INDEX IF EXISTS "JourneyVersion_trigger_state_idx";
--   ALTER TABLE "JourneyVersion" DROP COLUMN IF EXISTS "trigger";
--   ALTER TABLE "JourneyVersion" DROP COLUMN IF EXISTS "triggerConfig";
--
-- …together with legacyTriggerPair() in src/app/actions/journeys.ts and the two
-- fields in prisma/journeys.prisma. Do not land those three statements until
-- this release is deployed and every row and writer has been verified.

RESET app.bypass_rls;
