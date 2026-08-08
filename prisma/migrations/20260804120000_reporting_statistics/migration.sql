-- Long-term reporting statistics: pre-aggregated buckets + the rollup cursor,
-- plus the immutable Lead lifecycle dates the buckets are keyed on.
-- See prisma/statistics.prisma and src/lib/statistics.ts.
--
-- TIMESTAMP-PREFIXED, and it has to be. scripts/apply-migrations.mjs orders by
-- `Number.parseInt(name, 10)`, NOT lexicographically, so every timestamped
-- migration runs after every numerically-prefixed one. This migration indexes
-- "Lead" and "JobCard", which are created in 0_init — so a numeric prefix would
-- be fine for those — but the tenant columns it relies on are added by the
-- timestamped tenant-isolation migrations, and a `81_`-style name would sort as
-- 81 and run long before them. Anything touching a tenant column must be
-- timestamped. (It must also sort after 52_pipelines_forecasting_rbac_audit,
-- which adds "wonAt"/"lostAt" and the trigger that maintains them; every
-- timestamped migration does.)
--
-- ⚠ THE SOURCE-TABLE INDEXES AT THE BOTTOM BLOCK WRITES WHILE THEY BUILD, and
--    on a database where that matters THIS MIGRATION WILL REFUSE TO RUN until
--    scripts/prebuild-statistics-indexes.sql has been applied. That check is at
--    the bottom of this file and it is a hard failure, not a comment.
--
-- RE-RUNNABILITY. The runner applies SQL first and records second, so a crash
-- between the two re-runs this whole file. Every statement here is therefore
-- guarded — IF NOT EXISTS on the DDL, a WHERE clause that is already false on
-- the second pass for each backfill, DROP POLICY IF EXISTS before each CREATE
-- POLICY — and none of them narrows anything the previous build reads.

-- ── the RLS bypass, and why the backfills below are worthless without it ──────
--
-- "Lead" is FORCE ROW LEVEL SECURITY (20260727130000_rls_enforce), and FORCE
-- applies to the table owner too — which is the role this migration runs as. Its
-- policy admits a row only when `app.current_tenant` matches or `app.bypass_rls`
-- is on, and a migration session sets neither. So without this line every
-- statement below that touches "Lead" sees an EMPTY TABLE:
--
--   - `UPDATE "Lead" SET "wonAt" = …` matches zero rows and reports success, so
--     every deal closed before migration 52 keeps a NULL lifecycle date and is
--     silently absent from every won/lost number this feature will ever report;
--   - and the assertion written to catch exactly that counts zero orphans and
--     passes, because it is reading the same empty table. The one guard against
--     a silently short report would itself be silently vacuous.
--
-- The StatisticBucket / StatisticCursor repair below needs it for the same
-- reason on the SECOND run of this file: those tables gain FORCE RLS further
-- down, so a re-run after a crash reaches the repair with the policies already
-- live and would quietly correct nothing.
--
-- Set once at the top rather than around each block: everything here is a
-- migration-time, all-tenant operation, and a bypass that is on for some of the
-- file and off for the rest is the version somebody edits into a hole later.
SET app.bypass_rls = 'on';

-- -----------------------------------------------------------------------------
-- StatisticBucket — one pre-aggregated measurement.
-- -----------------------------------------------------------------------------
-- `id` is DERIVED from (tenantId, metric, period, bucketStart, dimension) by
-- statisticBucketId() rather than generated, and that is the idempotency
-- primitive: two rollup runs computing the same bucket compute the same id, so
-- they address the same row instead of inserting two. It also means the id
-- CONTAINS the tenant, so an id built for one workspace cannot address another's
-- row — belt and braces with the explicit `tenantId` predicate the rollup adds.
--
-- `tenantId` is NOT NULL, unlike most tenant columns in this schema. These
-- tables are new, so there is no legacy population to migrate and no reason to
-- inherit the nullable-tenant problem: the RLS policy below has no `IS NULL`
-- escape hatch, so a NULL-tenant bucket becomes invisible the moment strict
-- enforcement is switched on — silently orphaning a workspace's entire
-- reporting history at the exact moment isolation starts mattering.
CREATE TABLE IF NOT EXISTS "StatisticBucket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "sumCents" BIGINT NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatisticBucket_pkey" PRIMARY KEY ("id")
);

-- The read path: "this metric, this period, over this range" — every chart on
-- the Reports page. tenantId LEADS for the same reason it leads the journey
-- retention indexes: reads and the rollup both name the tenant explicitly, so
-- the emitted query is `tenantId = $1 AND metric = $2 AND period = $3 AND
-- bucketStart >= $4`, and without tenantId first one workspace's buckets are
-- walked by every other workspace's query.
CREATE INDEX IF NOT EXISTS "StatisticBucket_tenantId_metric_period_bucketStart_idx"
  ON "StatisticBucket"("tenantId", "metric", "period", "bucketStart");

-- The retention sweep's early-out: "are there day buckets older than the
-- cutoff?", asked once per tenant per tick and answered "no" almost always. The
-- index above cannot serve it — the sweep does not name a metric, and metric
-- sits between period and bucketStart.
CREATE INDEX IF NOT EXISTS "StatisticBucket_tenantId_period_bucketStart_idx"
  ON "StatisticBucket"("tenantId", "period", "bucketStart");

CREATE INDEX IF NOT EXISTS "StatisticBucket_tenantId_idx"
  ON "StatisticBucket"("tenantId");

-- -----------------------------------------------------------------------------
-- StatisticCursor — how far the rollup has consumed each source's change clock.
-- -----------------------------------------------------------------------------
-- One row per (tenant, source), not per metric: the three Lead metrics share
-- Lead's `updatedAt`, so they share one probe.
--
-- `backfillFrom` is the DURABLE BACKFILL PROGRESS MARKER. The initial backfill
-- walks history backwards in month-aligned slices and records this after each
-- one, so a tick killed by the route deadline loses at most one slice. Without
-- it, a database too large to backfill inside a single 60-second tick restarted
-- from today on EVERY tick and never produced a usable history at all.
CREATE TABLE IF NOT EXISTS "StatisticCursor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cursorAt" TIMESTAMP(3) NOT NULL,
    "cursorId" TEXT NOT NULL DEFAULT '',
    "backfillFrom" TIMESTAMP(3),
    "backfilledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatisticCursor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StatisticCursor_tenantId_idx"
  ON "StatisticCursor"("tenantId");

-- -----------------------------------------------------------------------------
-- Repair path for a database that already ran an EARLIER version of this file
-- -----------------------------------------------------------------------------
-- Every migration in this repo is idempotent and re-runnable, and the CREATE
-- TABLE statements above are `IF NOT EXISTS` — so a preview database that
-- applied the first version of this migration (nullable tenantId, no
-- backfillFrom, buckets keyed on `Lead.updatedAt`) would otherwise keep all
-- three defects for ever. These statements are no-ops on a fresh database.
--
-- ADD NULLABLE → BACKFILL → VERIFY → SET NOT NULL, in that order and in this one
-- migration. Adding the column already NOT NULL fails outright the moment a
-- single legacy row exists, and adding it NOT NULL DEFAULT '' would be worse: it
-- succeeds, and every existing bucket silently becomes a bucket belonging to a
-- tenant that does not exist. The `SET NOT NULL` at the end is not decoration —
-- it is the VERIFY step. It re-scans the table and fails the deploy if the
-- backfill missed a row (which, before the bypass at the top of this file, is
-- precisely what RLS would have caused).
--
-- Nothing here narrows a column the CURRENTLY-DEPLOYED build still writes: these
-- tables do not exist on main, so the only deployment that can reach the repair
-- path is a preview that ran the earlier draft, and no preview serves production
-- traffic.

ALTER TABLE "StatisticBucket" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "StatisticCursor" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "StatisticCursor" ADD COLUMN IF NOT EXISTS "backfillFrom" TIMESTAMP(3);

-- Un-owned rows belong to the FOUNDING tenant. That is not a guess: it is the
-- rule the whole platform already uses for a write made while enforcement is
-- dormant (withTenantWrite / repairsTenantId both resolve to DEFAULT_TENANT_ID),
-- and the rule every tenant-isolation migration backfilled with.
UPDATE "StatisticBucket" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "StatisticCursor" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

ALTER TABLE "StatisticBucket" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StatisticCursor" ALTER COLUMN "tenantId" SET NOT NULL;

-- Rows whose derived id no longer matches their tenant are UNREACHABLE: the
-- rollup addresses a bucket by an id it re-derives from (tenant, metric, …), so
-- a row keyed under the old null-tenant id ("-|…") would never be updated,
-- never be diffed and never be deleted — a number frozen on the chart for ever.
-- Deleting them makes the next tick rebuild the same buckets under correct ids.
DELETE FROM "StatisticBucket" WHERE left("id", length("tenantId") + 1) <> "tenantId" || '|';
DELETE FROM "StatisticCursor" WHERE left("id", length("tenantId") + 1) <> "tenantId" || '|';

-- Buckets built by the earlier version keyed `deals_won` / `deals_lost` on the
-- mutable `Lead.updatedAt`, which is the double-count bug this migration's Lead
-- work exists to fix. They cannot be corrected in place — the correct value has
-- to come from `wonAt`/`lostAt` — so they are dropped along with the cursors
-- that would stop them being rebuilt. A fresh database has none of these.
--
-- RE-RUNNABLE BUT NOT A NO-OP, and that is the one statement here of which that
-- is true. A crash between applying this file and recording it re-runs these two
-- DELETEs against a database where the rollup may already have built correct
-- buckets, and discards them. The cost is a rebuild, not a wrong number: without
-- a `lead` cursor the next tick backfills the history again from source, and
-- `readyStatisticSources` reports the source as unbuilt in the meantime, so the
-- Reports page serves the live query rather than a half-built table. Cheap
-- enough, and far cheaper than the alternative — a condition narrow enough to
-- spare the good buckets would have to distinguish them by value, which is
-- precisely the thing that cannot be recomputed from a bucket.
DELETE FROM "StatisticBucket" WHERE "metric" IN ('deals_won', 'deals_lost');
DELETE FROM "StatisticCursor" WHERE "source" = 'lead';

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
-- FORCE RLS is live on every tenant table from 20260727130000_rls_enforce. A new
-- tenant table that skips this is not "safe by default" — it is the one table in
-- the schema with no row-level boundary, and it is a table of AGGREGATES, where
-- a leak is not a visible foreign record but two workspaces' numbers silently
-- summed into one chart.
--
-- No `OR "tenantId" IS NULL` escape hatch: there is no such thing as a shared,
-- tenantless statistic, and the column is NOT NULL precisely so there never can
-- be one.
ALTER TABLE "StatisticBucket" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StatisticBucket_tenant_isolation" ON "StatisticBucket";
CREATE POLICY "StatisticBucket_tenant_isolation" ON "StatisticBucket"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StatisticBucket" FORCE ROW LEVEL SECURITY;

ALTER TABLE "StatisticCursor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StatisticCursor_tenant_isolation" ON "StatisticCursor";
CREATE POLICY "StatisticCursor_tenant_isolation" ON "StatisticCursor"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StatisticCursor" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Lead lifecycle dates — the columns the won/lost buckets are actually keyed on
-- -----------------------------------------------------------------------------
-- A MUTABLE COLUMN MUST NEVER FEED A PERMANENTLY SEALED BUCKET.
--
-- The Reports page dates a won deal by `Lead.updatedAt`, and the first version
-- of this feature copied that. It is safe for a query that recomputes
-- everything on every page view and catastrophic for a bucket table that seals
-- a period after 35 days:
--
--   A deal is won in March; the March bucket records it. March seals. In August
--   someone adds a note; `updatedAt` moves to August; the incremental rollup
--   files the deal into August as well. March is outside the recompute window
--   and keeps its count. One deal, counted in two months, silently and for
--   ever. Change that March win to LOST in August and the historical win stays
--   put while a brand-new loss appears alongside it.
--
-- "wonAt" and "lostAt" already exist on this table — added by
-- 52_pipelines_forecasting_rbac_audit, which also installs the
-- Lead_sync_pipeline_forecast trigger that sets each one the first time a deal
-- reaches that status and preserves it (COALESCE) on every later write. They
-- are in no Prisma model, which does not matter: the rollup's aggregate is raw
-- SQL against this table.
--
-- What was missing is a value for the rows that were already won or lost before
-- that migration ran, and indexes to range on.

-- ── the backfill, and exactly what it is worth ───────────────────────────────
--
-- EVIDENCE: `updatedAt`. It is the same date the app has always used for these
-- deals, so the backfilled buckets reproduce the numbers the Reports page shows
-- today, rather than quietly restating history the first time anyone looks.
--
-- LIMITATION, stated plainly: for a deal closed long ago and edited since,
-- `updatedAt` is the date of the last EDIT, not of the close — so a pre-trigger
-- deal may be filed later than it truly closed, and two deals closed in the same
-- month can land in different months. Nothing in the database records when those
-- deals actually closed, so the alternative is not a better date, it is no date.
--
-- WHAT IT NEVERTHELESS FIXES: the value is written ONCE and then never moves
-- again. The date may be approximate; it is no longer a moving target, which is
-- the property sealing depends on.
--
-- The rows this touches are closed deals that predate migration 52 and have no
-- lifecycle date at all; on a database deployed after that migration it updates
-- nothing.
UPDATE "Lead" SET "wonAt" = "updatedAt" WHERE "status" = 'won' AND "wonAt" IS NULL;
UPDATE "Lead" SET "lostAt" = "updatedAt" WHERE "status" = 'lost' AND "lostAt" IS NULL;

-- A won deal with no `wonAt` is INVISIBLE to the buckets: the aggregate ranges
-- on that column and a NULL is outside every range, so the deal is not
-- double-counted, it is not counted at all. After the backfill above there can
-- be none — unless migration 52's trigger has been dropped, in which case new
-- closes are not getting a lifecycle date either and every won/lost number this
-- feature reports would be silently short. Fail the deploy rather than ship it.
--
-- Only reachable as a genuine failure. A deal closed by another session between
-- the UPDATE and this SELECT already carries its date: the trigger stamps
-- `wonAt`/`lostAt` in the same BEFORE UPDATE that sets the status, so a
-- concurrent close cannot present as an orphan and make this fire spuriously.
--
-- It is also only meaningful because of the bypass at the top of this file:
-- under FORCE RLS this reads an empty table and passes no matter what is in it.
DO $$
DECLARE
  orphans BIGINT;
BEGIN
  SELECT count(*) INTO orphans
  FROM "Lead"
  WHERE ("status" = 'won' AND "wonAt" IS NULL)
     OR ("status" = 'lost' AND "lostAt" IS NULL);

  IF orphans > 0 THEN
    RAISE EXCEPTION
      'Reporting statistics: % closed Lead row(s) have no wonAt/lostAt after the backfill. '
      'The Lead_sync_pipeline_forecast trigger from 52_pipelines_forecasting_rbac_audit is '
      'missing or disabled, so lifecycle dates are not being maintained. Restore the trigger '
      '(the function is CREATE OR REPLACE, but re-running the whole of migration 52 is NOT '
      'safe — its ALTER TABLE ADD COLUMN statements are unguarded), then redeploy.',
      orphans;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Source-table indexes for the rollup
-- -----------------------------------------------------------------------------
-- ⚠ THESE ARE DECLARED HERE ONLY, NOT IN prisma/schema.prisma.
--
-- "Lead" and "JobCard" live in prisma/schema.prisma, which parallel work has
-- open; adding six @@index lines to those models would conflict textually. The
-- indexes are therefore created here and are invisible to the Prisma schema.
-- That divergence is SAFE with this repo's tooling but it is a debt, so it is
-- worth being precise about both halves:
--
--   safe   — the deploy-time integrity probe (scripts/apply-migrations.mjs,
--            assertSchemaObjectsPresent) diffs FROM the database TO the schema
--            and blocks only on CREATE TABLE / ADD COLUMN, i.e. objects the
--            database LACKS. An index the database has and the schema does not
--            appears as a DROP, which classifyDiffScript ignores outright.
--   debt   — a future `prisma migrate dev` run against schema.prisma would
--            generate a DROP for them. Fold the six @@index lines into the
--            Lead and JobCard models once schema.prisma is free.
--
-- tenantId LEADS all six. The rollup names the tenant in every query it makes
-- (src/lib/statistics.ts, tenantSql / tenantWhere), whether or not enforcement
-- is on, so every query below is emitted as `tenantId = $1 AND …`. Without
-- tenantId first, the quietest workspace's early-out pays for the busiest
-- workspace's history on every single tick — the exact failure the journey
-- retention indexes were reshaped to avoid.
--
-- HONEST CAVEAT: the founding tenant's predicate is `("tenantId" = $1 OR
-- "tenantId" IS NULL)` while legacy un-owned rows still exist, which Postgres
-- serves as a BitmapOr of two scans of these same indexes rather than one. That
-- costs a little now and nothing once the tenantId backfill is complete.

-- ── the write-lock gate ──────────────────────────────────────────────────────
--
-- A plain CREATE INDEX takes a SHARE lock, which blocks INSERT/UPDATE/DELETE for
-- the whole build; "Lead" is the busiest table in the CRM. CREATE INDEX
-- CONCURRENTLY does not block writes, and cannot be used here: this repo applies
-- migrations with `prisma db execute --file` (scripts/apply-migrations.mjs,
-- applyOne), which submits the WHOLE file as one multi-statement script, and
-- Postgres runs such a script inside an implicit transaction block. CONCURRENTLY
-- refuses to run in one, so using it here would not trade a lock for
-- availability — it would abort this migration and ship no index at all.
--
-- So the concurrent build lives in scripts/prebuild-statistics-indexes.sql, and
-- THIS BLOCK MAKES RUNNING IT A PRECONDITION rather than a comment somebody
-- may not read. On a table large enough for the lock to be an outage, a missing
-- index fails the deploy with the command to fix it. On a small or empty table
-- — CI, disaster recovery, a new workspace — the builds below are trivial and
-- this waves them through.
--
-- Deliberate escape hatch for an operator who has decided the pause is
-- acceptable (a maintenance window, a restore):
--     SET app.allow_blocking_index_build = 'on';
-- in the same session, before applying migrations.
DO $$
DECLARE
  spec        RECORD;
  table_bytes BIGINT;
  approx_rows BIGINT;
  unbuilt     TEXT := '';
  message     TEXT;
BEGIN
  IF current_setting('app.allow_blocking_index_build', true) = 'on' THEN
    RAISE NOTICE 'Reporting statistics: blocking index builds explicitly permitted for this session.';
    RETURN;
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('Lead',    'Lead_tenantId_updatedAt_id_idx'),
      ('Lead',    'Lead_tenantId_createdAt_idx'),
      ('Lead',    'Lead_tenantId_wonAt_idx'),
      ('Lead',    'Lead_tenantId_lostAt_idx'),
      ('JobCard', 'JobCard_tenantId_updatedAt_id_idx'),
      ('JobCard', 'JobCard_tenantId_createdAt_idx'),
      ('JobCard', 'JobCard_tenantId_completedAt_idx')
    ) AS t(table_name, index_name)
  LOOP
    SELECT pg_table_size(c.oid), GREATEST(c.reltuples, 0)::bigint
      INTO table_bytes, approx_rows
      FROM pg_class c
     WHERE c.oid = format('%I', spec.table_name)::regclass;

    -- 32 MB / 100k rows: comfortably past the point where a build is measured
    -- in milliseconds, comfortably below any workspace that would notice.
    CONTINUE WHEN table_bytes < 32 * 1024 * 1024 AND approx_rows < 100000;
    CONTINUE WHEN to_regclass(format('%I', spec.index_name)) IS NOT NULL;

    unbuilt := unbuilt || E'\n    ' || spec.index_name || '  on "' || spec.table_name || '"';
  END LOOP;

  -- Assembled with `||` into ONE value, then raised with USING MESSAGE.
  --
  -- The previous version relied on adjacent string literals being joined into a
  -- single format string. That happens in ordinary expressions; it does NOT
  -- happen in RAISE's format slot, which requires one literal. So this migration
  -- did not parse at all:
  --
  --     syntax error at or near
  --     E'These indexes are missing, and this migration would build them ...'
  --
  -- and because scripts/apply-migrations.mjs runs in the Vercel build command
  -- and fails closed, that would not merely break reporting — it would block
  -- every deploy afterwards, including the one carrying the fix.
  --
  -- `%s` was wrong as well: PL/pgSQL's placeholder is `%`, so the list would have
  -- been followed by a stray "s". Interpolating it directly removes the question.
  IF unbuilt <> '' THEN
    message :=
      E'Reporting statistics: refusing to build indexes inline on a busy table.\n'
      || E'These indexes are missing, and this migration would build them while holding a lock '
      || E'that blocks every INSERT, UPDATE and DELETE on the table for the whole build:'
      || unbuilt || E'\n\n'
      || E'Build them WITHOUT blocking writes first, then redeploy:\n\n'
      || E'    psql "$DATABASE_URL_UNPOOLED" -f scripts/prebuild-statistics-indexes.sql\n\n'
      || E'That script uses CREATE INDEX CONCURRENTLY, which cannot run inside this migration '
      || E'because Prisma wraps each migration in a transaction. It is safe to re-run. Once the '
      || E'indexes exist, the CREATE INDEX IF NOT EXISTS statements below are no-ops and the '
      || E'deploy takes no lock at all.\n\n'
      || E'To accept the write pause instead - a maintenance window, a restore - run\n'
      || E'    SET app.allow_blocking_index_build = ''on'';\n'
      || E'in the same session before applying migrations.';
    RAISE EXCEPTION USING MESSAGE = message;
  END IF;
END $$;

-- The change probe and the cursor position: `updatedAt > $2 OR (updatedAt = $2
-- AND id > $3)`, ordered (updatedAt, id). `id` is in the index so the ORDER BY
-- is satisfied by the scan rather than by a sort of every tied row.
CREATE INDEX IF NOT EXISTS "Lead_tenantId_updatedAt_id_idx"
  ON "Lead"("tenantId", "updatedAt", "id");

-- The leads_created window aggregate ranges on "createdAt", which nothing
-- indexed. Without this the rollup sequential-scans "Lead" every time a lead is
-- touched — which, on a working CRM, is every tick.
CREATE INDEX IF NOT EXISTS "Lead_tenantId_createdAt_idx"
  ON "Lead"("tenantId", "createdAt");

-- The deals_won / deals_lost aggregates range on the IMMUTABLE lifecycle dates,
-- and the backfill walk asks each column for its MIN. Both are answered from
-- these indexes; without them every won/lost recompute is a sequential scan.
CREATE INDEX IF NOT EXISTS "Lead_tenantId_wonAt_idx"
  ON "Lead"("tenantId", "wonAt");

CREATE INDEX IF NOT EXISTS "Lead_tenantId_lostAt_idx"
  ON "Lead"("tenantId", "lostAt");

CREATE INDEX IF NOT EXISTS "JobCard_tenantId_updatedAt_id_idx"
  ON "JobCard"("tenantId", "updatedAt", "id");

CREATE INDEX IF NOT EXISTS "JobCard_tenantId_createdAt_idx"
  ON "JobCard"("tenantId", "createdAt");

-- The jobcards_completed window aggregate ranges on "completedAt".
CREATE INDEX IF NOT EXISTS "JobCard_tenantId_completedAt_idx"
  ON "JobCard"("tenantId", "completedAt");

-- Hand the session back exactly as it was found.
--
-- Belt and braces, deliberately. Two things would already contain the bypass:
-- `SET` without `LOCAL` is undone if the implicit transaction around this script
-- aborts, and the runner spawns a fresh `prisma db execute` — a new connection —
-- for each migration, so it cannot leak into the next one as this file is
-- applied today. Neither is a property worth depending on: both are facts about
-- the RUNNER, they are exactly the kind of thing that changes without anyone
-- rereading a migration from months ago, and a bypass left armed disarms RLS for
-- whatever runs next in the same session — which is only ever noticed by the
-- statement that needed the boundary and silently did not get it.
RESET app.bypass_rls;
