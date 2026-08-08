-- User-built dashboards (prisma/dashboards.prisma), plus a backfill of every
-- existing DashboardLayout row into one.
--
-- TIMESTAMP-PREFIXED, AND IT HAS TO STAY THAT WAY. scripts/apply-migrations.mjs
-- orders migrations by `Number.parseInt(name, 10)`, NOT lexicographically. Every
-- timestamped name parses to a 14-digit number and therefore runs after every
-- numerically-prefixed one, so a `156_`-style name here would sort as 156 and run
-- in the middle of the legacy sequence — long before 20260804100000 creates
-- DashboardLayout, and the backfill below would die on `relation
-- "DashboardLayout" does not exist`. The prefix is later than 20260804100000 so
-- this lands after it.
--
-- ADDITIVE ONLY. This creates a table and copies data forward. It does not DROP,
-- ALTER or TRUNCATE anything, and in particular it leaves DashboardLayout fully
-- intact and still written by the old action. A one-way migration is not
-- acceptable for the home screen: if the new path has to be reverted, the old
-- code must still find every user's arrangement exactly where it left it.
--
-- Idempotent throughout — apply-migrations.mjs executes the SQL and only then
-- records it, so a run that fails partway is re-executed on the next deploy.

CREATE TABLE IF NOT EXISTS "Dashboard" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT,
  "userId"    TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "icon"      TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "config"    JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- "the dashboard at this address, for this user, in this tenant" — the lookup
-- behind every dashboard page load. tenantId LEADS because every query runs
-- inside a tenant scope, so the predicate the Prisma extension emits begins
-- `tenantId = $1 AND "userId" = $2`.
CREATE UNIQUE INDEX IF NOT EXISTS "Dashboard_tenantId_userId_slug_key"
  ON "Dashboard"("tenantId", "userId", "slug");

-- The index above does NOT constrain rows whose tenantId IS NULL, because
-- Postgres treats two NULLs as distinct: (NULL,'user-1','home') does not collide
-- with (NULL,'user-1','home'). Tenant enforcement is dormant today, so EVERY row
-- is written with tenantId NULL and the constraint that is supposed to guarantee
-- "one dashboard per address per user" guarantees nothing at all.
--
-- The failure that produces is quiet and confusing rather than loud: two rows
-- share a slug, `findFirst` returns whichever the planner reaches first, and a
-- user's edits can be saved into one row while their screen renders from the
-- other — so the save button appears to do nothing. A double-clicked "New
-- dashboard", or two open tabs, is all it takes.
--
-- This partial index closes that window for exactly the NULL case and stops
-- applying on its own once tenantId is populated. Both indexes are needed: this
-- one until tenancy is enforced, the composite one after.
CREATE UNIQUE INDEX IF NOT EXISTS "Dashboard_userId_slug_untenanted_key"
  ON "Dashboard"("userId", "slug")
  WHERE "tenantId" IS NULL;

-- The switcher's list query: this user's dashboards in sortOrder. The unique
-- index above cannot serve it — it orders by slug, so reading the list out of it
-- means re-sorting every row on every page load, and the switcher is rendered on
-- every dashboard request.
CREATE INDEX IF NOT EXISTS "Dashboard_tenantId_userId_sortOrder_idx"
  ON "Dashboard"("tenantId", "userId", "sortOrder");

-- No CREATE INDEX CONCURRENTLY anywhere above, and there must never be: Prisma
-- Migrate wraps each migration in a transaction and CONCURRENTLY cannot run
-- inside one. Using it here would not trade a lock for availability — it would
-- fail the migration outright and ship no index at all. The table is brand new
-- and empty at this point regardless, so the builds are instant.

-- FORCE ROW LEVEL SECURITY is live database-wide, so a new table WITHOUT a policy
-- returns zero rows to the application. The failure presents as "every dashboard
-- is empty" rather than as an error, which is exactly the kind that reaches
-- production. The policy is the one every other tenant-owned table carries: the
-- trusted bypass path (basePrisma, backups, cron, and this migration) sets
-- app.bypass_rls, and a tenant-scoped request matches its own tenantId.
--
-- Deliberately NO `"tenantId" IS NULL` arm, matching DashboardLayout and for the
-- same reason. On Role/RolePermission a NULL tenantId means "a seeded row shared
-- by every tenant" and the policy has to admit it. Here NULL only ever means
-- "written while tenancy was dormant", and a dormant request bypasses RLS anyway
-- (db.ts sets app.bypass_rls whenever tenantEnforcing() is false), so the arm
-- would buy nothing today while making one tenant's dashboards readable from
-- another the moment enforcement came on. A dashboard belongs to one user in one
-- tenant and is never shared.
ALTER TABLE "Dashboard" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Dashboard_tenant_isolation" ON "Dashboard";
CREATE POLICY "Dashboard_tenant_isolation" ON "Dashboard"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Dashboard" FORCE ROW LEVEL SECURITY;

-- ── backfill ───────────────────────────────────────────────────────────────
--
-- WITHOUT THIS NEXT LINE THE BACKFILL SILENTLY COPIES NOTHING. DashboardLayout
-- carries FORCE ROW LEVEL SECURITY, which applies to the table owner too, and
-- this migration connects with neither app.bypass_rls nor app.current_tenant
-- set — so its policy evaluates to `NULL = NULL`, the SELECT below returns zero
-- rows, the INSERT inserts zero rows, and the migration reports success. Every
-- user's arrangement would be quietly left behind. Setting the bypass GUC is what
-- makes the read (and the WITH CHECK on the write above) actually see the data.
-- Plain SET rather than SET LOCAL, because `prisma db execute` does not guarantee
-- the file runs inside one transaction; RESET at the end returns the session to
-- where it started.
SET app.bypass_rls = 'on';

-- One "Home" dashboard per existing layout row.
--
-- THE ID IS REUSED FROM THE LAYOUT ROW, which is what makes this re-runnable: a
-- second execution collides on the primary key and does nothing, instead of
-- giving every user a duplicate dashboard. `ON CONFLICT DO NOTHING` with no
-- target covers the unique indexes too, so a user who has already created their
-- own `home` through the app keeps it — the backfill never overwrites.
--
-- The config it builds is one view holding one section holding the user's saved
-- card ids as builtin cards, in their saved order. That is the same screen they
-- had, expressed in the new model.
--
-- The card ids are NOT validated against the catalogue here, deliberately, for
-- the reason the DashboardLayout doc gives: the catalogue lives in TypeScript and
-- encoding it in SQL would mean migrating every row whenever a card is renamed.
-- An id that no longer exists is dropped by `parseConfig` on read, costing one
-- card and nothing else.
--
-- `span` IS resolved here, from the CASE below, and the difference from the
-- card ids above is worth being explicit about because the two look alike.
--
-- The card CATALOGUE is open-ended: cards get added and renamed every release,
-- so encoding it in SQL would mean a migration to rewrite whenever one changes.
-- The widths are a different kind of fact. This statement runs ONCE, against the
-- rows that exist on the day it runs, and never again — so "today's widths" is
-- not a snapshot that can go stale, it is the only value the statement will ever
-- need. A card renamed next year does not retroactively change what these rows
-- should have been backfilled with.
--
-- Leaving them all at 1 was the alternative, and it costs more than it looks:
-- every span in the stored config would then be a lie that only renders
-- correctly because the renderer quietly ignores it for one card type. That is a
-- second rule about widths, applying to one variant, discoverable only by
-- reading the renderer — and the next person to touch either side has no way to
-- know the two disagree on purpose. Writing the real width means `span` means
-- the same thing in every card in the config, which is the whole point of
-- having one card model.
--
-- Any id not listed falls to 1, which is both the schema default and the right
-- answer for a card this migration has never heard of.
INSERT INTO "Dashboard" (
  "id", "tenantId", "userId", "slug", "title", "icon", "sortOrder", "config",
  "createdAt", "updatedAt"
)
SELECT
  layout."id",
  layout."tenantId",
  layout."userId",
  'home',
  'Home',
  NULL,
  0,
  jsonb_build_object(
    'version', 1,
    'views', jsonb_build_array(
      jsonb_build_object(
        'id', 'view-home',
        'title', 'Home',
        'path', 'home',
        'columns', 3,
        'sections', jsonb_build_array(
          jsonb_build_object(
            'id', 'section-home',
            'columnSpan', 3,
            'cards', COALESCE(built."cards", '[]'::jsonb)
          )
        )
      )
    )
  ),
  layout."createdAt",
  layout."updatedAt"
FROM "DashboardLayout" layout
-- LEFT JOIN LATERAL, not an inner one: a user whose saved list is empty (they
-- removed every card, which is a real choice the old UI allowed) must still get
-- their dashboard, with an empty section rather than no row at all.
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object(
             'id',   'card-' || entry."ord",
             'type', 'builtin',
             'card', entry."value" #>> '{}',
             'span', CASE entry."value" #>> '{}'
                       WHEN 'system-alerts'     THEN 3
                       WHEN 'sales-stats'       THEN 3
                       WHEN 'new-leads'         THEN 1
                       WHEN 'pipeline-snapshot' THEN 2
                       WHEN 'month-targets'     THEN 1
                       WHEN 'sales-agenda'      THEN 2
                       WHEN 'out-for-signature' THEN 1
                       WHEN 'needs-attention'   THEN 2
                       WHEN 'latest-activity'   THEN 3
                       WHEN 'service-stats'     THEN 3
                       WHEN 'service-agenda'    THEN 2
                       WHEN 'service-due'       THEN 1
                       ELSE 1
                     END
           )
           ORDER BY entry."ord"
         ) AS "cards"
  FROM jsonb_array_elements(
         -- `cards` is untrusted JSON: it has only ever been written by the app,
         -- but jsonb_array_elements ERRORS on a non-array and that error would
         -- fail the whole deploy over one malformed row. Coercing to an empty
         -- array degrades it to an empty dashboard instead, which is what the
         -- read path already does with the same value.
         CASE WHEN jsonb_typeof(layout."cards") = 'array'
              THEN layout."cards"
              ELSE '[]'::jsonb
         END
       ) WITH ORDINALITY AS entry("value", "ord")
  -- Non-string entries are dropped rather than stringified, matching
  -- normaliseLayout. The resulting gaps in `ord` are harmless: card ids only have
  -- to be unique within the config, not contiguous.
  WHERE jsonb_typeof(entry."value") = 'string'
    -- LIMITS.cardsPerSection in src/lib/dashboard/config.ts. The old cap
    -- (MAX_CARDS) is the same number, so this only ever binds on a row written
    -- before a future cap change — but a backfilled config that the strict parser
    -- would refuse is a dashboard the user could never save again, so it is worth
    -- the clause.
    AND entry."ord" <= 24
) built ON TRUE
ON CONFLICT DO NOTHING;

RESET app.bypass_rls;
