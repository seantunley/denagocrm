-- =============================================================================
-- THE APPLICATION DATABASE ROLE — the one that does NOT bypass RLS
-- =============================================================================
--
-- 20260727130000_rls_enforce turned Row Level Security ON and FORCE'd it on 120
-- tables. That work is correct and it is inert, because of one fact it could not
-- change from inside a migration:
--
--     the application connects as `neondb_owner`, and `neondb_owner` carries the
--     role attribute BYPASSRLS.
--
-- FORCE ROW LEVEL SECURITY defeats the *table owner's* exemption. It does not
-- defeat the *role attribute*. A role with BYPASSRLS is never subject to a
-- policy on any table, forced or not — so every policy in that migration is
-- evaluated exactly never. Proven on production, read-only, 2026-08-06:
-- `app.current_tenant` unset, `SELECT count(*) FROM "Contact"` returned 17. The
-- policy says 0.
--
-- This script creates the role that the application should have been connecting
-- as all along. It grants exactly the four DML verbs and nothing else: no DDL,
-- no TRUNCATE, no ownership, no ability to disable a policy on a table it does
-- not own. RLS is only a boundary when the role on the other side of it cannot
-- step over it.
--
-- ── RUN THIS AS THE OWNER (neondb_owner). It is idempotent. ──────────────────
--
-- Read docs/RLS-ROLE-CUTOVER.md before running. The ORDER matters: this script
-- is safe to run at any time and changes nothing about the running application,
-- because nothing connects as the new role until DATABASE_URL is repointed. That
-- is deliberate — create and verify first, cut over second, as two separate
-- decisions with a green check in between.
--
-- To use a different role name, change it in the three places marked ROLE NAME
-- and in scripts/check-rls-role.ts (APP_ROLE).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The role
-- -----------------------------------------------------------------------------
-- ⛔ NOTE ON NEON — CREATE THIS ROLE HERE, IN SQL. NEVER IN THE NEON CONSOLE.
--
-- This note used to say the opposite: prefer the console, because a
-- console-created role is registered with Neon's connection proxy and is
-- therefore usable on the POOLED endpoint. Both halves of that were wrong, and
-- following it on 2026-08-12 produced a role that defeats the entire purpose of
-- this file.
--
--   1. A ROLE CREATED IN THE NEON CONSOLE IS CREATED *WITH* BYPASSRLS — the same
--      profile as neondb_owner (verified on production: crm_app came back
--      rolbypassrls=true, rolcreaterole=true). Every policy on all 120 forced
--      tables is then evaluated exactly never, which is the precise failure this
--      role exists to end.
--
--   2. IT CANNOT BE REPAIRED. Only a superuser may clear BYPASSRLS, Neon exposes
--      none, and `neondb_owner` cannot even DROP OWNED BY / DROP ROLE a
--      console-created role. There is no way back except recreating it.
--
--   3. THE PREMISE WAS FALSE ANYWAY. A role created by the CREATE ROLE below
--      authenticates on the POOLED endpoint perfectly well — confirmed on
--      production. Nothing was gained by using the console.
--
-- CREATE ROLE ... NOBYPASSRLS is unrestricted: superuser is needed to GRANT a
-- privilege, not to WITHHOLD one. So the role can only be born correct, and this
-- is where that happens.
--
-- The attributes below are the requirement, and step 5 verifies them:
--   NOSUPERUSER   — a superuser bypasses RLS unconditionally.
--   NOBYPASSRLS   — the whole point. This is the attribute neondb_owner has.
--   NOCREATEROLE  — cannot grant itself anything, or create a role that can.
--   NOCREATEDB    — no reason to.
--   NOINHERIT     — must not pick up privileges by being added to a group later.

DO $$
BEGIN
  -- ROLE NAME (1 of 3)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    -- Created with a password NOBODY KNOWS, on purpose. A placeholder literal in
    -- a file in the repository is a login credential in the repository, and the
    -- one thing worse than a role that bypasses RLS is a role that does not,
    -- with a public password. The operator must ALTER ROLE it to something real
    -- before the role can be used, which is step 2 of the cutover runbook.
    EXECUTE 'CREATE ROLE crm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '
      || quote_literal(md5(random()::text || clock_timestamp()::text));
    RAISE NOTICE 'created role crm_app with an unknown password — ALTER ROLE crm_app PASSWORD ''…'' before use';
  ELSE
    RAISE NOTICE 'role crm_app already exists — leaving its password alone';
  END IF;
END $$;

-- Re-assert the attributes even when the role already existed. A role created in
-- the Neon console does not necessarily have them, and a role that silently
-- gained BYPASSRLS later is the exact failure this whole script exists to stop.
--
-- ON NEON THIS CANNOT BE A BARE `ALTER ROLE`, and the reason is worth stating
-- because it invalidates the advice above it.
--
-- Only a SUPERUSER may change the BYPASSRLS attribute. `neondb_owner` is
-- `rolsuper = false` and Neon exposes no real superuser, so
-- `ALTER ROLE crm_app NOBYPASSRLS` fails with
-- `ERROR: permission denied to alter role (42501)` — and Postgres checks the
-- permission whether or not the change is a no-op, so it fails even when the
-- attributes are ALREADY correct. Run through `psql` or `prisma db execute`,
-- that aborts the whole file; run through Neon's SQL editor, it reports one red
-- statement and carries on, leaving the grants applied and the attributes not.
--
-- Worse, a role created in the NEON CONSOLE is created WITH BYPASSRLS — the same
-- profile as neondb_owner (verified on production 2026-08-12: crm_app came back
-- rolbypassrls=true, rolcreaterole=true). So the console route, which the note
-- above recommends, produces a role that defeats the entire purpose and cannot
-- then be repaired from SQL.
--
-- CREATE ROLE with NOBYPASSRLS is unrestricted — you need superuser to GRANT a
-- privilege, not to withhold one — so the role must be created correctly in the
-- first place, via SQL, and never repaired afterwards. See docs/RLS-ROLE-CUTOVER.md.
--
-- This block therefore VERIFIES rather than asserts: it repairs what it is
-- permitted to repair, and fails loudly and specifically on the one attribute it
-- cannot, instead of dying on a permission error that says nothing about why.
-- ROLE NAME (2 of 3)
DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'crm_app';
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION
      'crm_app has rolsuper=% rolbypassrls=% and NEITHER can be removed without superuser, which Neon does not provide. '
      'This role was almost certainly created in the Neon console, which creates roles WITH BYPASSRLS. '
      'It cannot be repaired — drop it and recreate it in SQL: '
      'DROP OWNED BY crm_app; DROP ROLE crm_app; '
      'CREATE ROLE crm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ''...'';',
      r.rolsuper, r.rolbypassrls;
  END IF;
  -- These four are alterable by a CREATEROLE role, so a drifted role can be
  -- corrected in place without recreating it.
  EXECUTE 'ALTER ROLE crm_app NOCREATEDB NOCREATEROLE NOINHERIT';
  RAISE NOTICE 'crm_app attributes verified: NOBYPASSRLS already set, NOCREATEDB/NOCREATEROLE/NOINHERIT applied';
END $$;


-- -----------------------------------------------------------------------------
-- 2. Privileges on what exists today
-- -----------------------------------------------------------------------------
-- ROLE NAME (3 of 3) — everything below this line refers to crm_app.

-- CONNECT has to be granted on a database named literally, and the name differs
-- between production (neondb), the dev branch and the disposable test database —
-- so it is built from current_database() rather than hardcoded to whichever one
-- happened to be open when this was written.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crm_app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO crm_app;

-- The four DML verbs, and only those. Deliberately NOT granted:
--   TRUNCATE  — bypasses row-level DELETE policies entirely. A tenant-scoped
--               role with TRUNCATE can empty another tenant's table.
--   REFERENCES / TRIGGER — DDL-adjacent; the app never needs them.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;


-- -----------------------------------------------------------------------------
-- 3. Privileges on what does not exist yet  ← THE ONE THAT BREAKS PRODUCTION
-- -----------------------------------------------------------------------------
-- `GRANT ... ON ALL TABLES` is a loop over the tables that exist at the instant
-- it runs. It is not a rule. The next migration that adds a table creates it
-- owned by neondb_owner with no grant to crm_app at all — and the first request
-- to touch it fails with "permission denied for table X", in production, on a
-- deploy that passed every test.
--
-- ALTER DEFAULT PRIVILEGES is the rule. It is attached to the CREATING role, so
-- it must name the role migrations run as (neondb_owner via DATABASE_URL_UNPOOLED),
-- not the role reading them.
-- Guarded: neondb_owner is a Neon-ism and does not exist on a self-hosted
-- install or on the disposable database `npm run test:rls-restricted` builds.
-- Unguarded, this line would abort the whole script there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neondb_owner') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app';
    RAISE NOTICE 'default privileges attached to neondb_owner (future migrations)';
  ELSE
    RAISE NOTICE 'neondb_owner not present — skipping (self-hosted or test database)';
  END IF;
END $$;

-- Also attach it to whoever is running THIS script, in case that is not
-- neondb_owner (a self-hosted install, or the test database's bootstrap user).
-- Harmless and idempotent when it is the same role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;


-- -----------------------------------------------------------------------------
-- 4. What is deliberately NOT here
-- -----------------------------------------------------------------------------
-- No GRANT on `_prisma_migrations`: it is covered by ALL TABLES above, which is
-- fine (the app never writes it), but nothing here gives crm_app the ability to
-- record a migration as applied. The runner connects as the owner.
--
-- No `ALTER ROLE crm_app SET ...` for app.current_tenant. The GUC is set per
-- transaction by src/lib/db.ts. A role-level default would be a second place
-- that decides tenant scope, and the wrong one would be silent.
--
-- No BYPASSRLS escape hatch. If enforcement has to be switched off it is done in
-- the application (TENANT_ENFORCEMENT=off → withRlsScope sets app.bypass_rls),
-- which is revertible in one deploy and leaves an audit trail. A role attribute
-- would be invisible from inside the app.


-- -----------------------------------------------------------------------------
-- 5. Verify, loudly
-- -----------------------------------------------------------------------------
-- Fails the script if the role can still bypass RLS. Belt and braces: the same
-- check is the first thing scripts/check-rls-role.ts asserts, over the network,
-- against whatever DATABASE_URL actually points at.
DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'crm_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role crm_app does not exist';
  END IF;
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION 'crm_app can bypass RLS (rolsuper=% rolbypassrls=%) — every policy would be inert', r.rolsuper, r.rolbypassrls;
  END IF;
  RAISE NOTICE 'crm_app: NOSUPERUSER NOBYPASSRLS confirmed';
END $$;
