-- ONE TENANT PER USER, enforced by the database.
--
-- Sign-in resolves the acting tenant with `soleActiveTenant`, which requires
-- EXACTLY ONE active membership: zero yields `no_tenant`, two or more yield
-- `ambiguous_tenant`. Both resolve to no honoured tenant claim, and under
-- enforcement that means the user cannot sign in AT ALL. A second membership
-- therefore does not widen a user's access — it destroys it.
--
-- An application-level check cannot hold this invariant:
--   * two concurrent additions can both pass the check and both insert;
--   * a membership in an INACTIVE tenant passes an "active only" check, then
--     becomes ambiguous the moment that tenant is activated.
-- A unique index closes both: it is atomic, and it covers memberships regardless
-- of tenant state.
--
-- FAILS LOUDLY if a user already holds more than one membership. That is
-- deliberate: such a user is ALREADY unable to sign in under enforcement, and
-- silently discarding one of their memberships would be a data-loss decision this
-- migration has no business making. The query below reports offenders so they can
-- be resolved by hand first.

DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(format('%s (%s memberships)', "userId", n), ', ')
    INTO offenders
    FROM (
      SELECT "userId", count(*) AS n
      FROM "TenantMember"
      GROUP BY "userId"
      HAVING count(*) > 1
    ) dupes;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one-tenant-per-user: these users hold multiple memberships: %. Resolve them (remove the memberships that should not exist) and re-run.',
      offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TenantMember_userId_key"
  ON "TenantMember"("userId");

-- The plain index is now redundant: the unique index serves the same lookups.
DROP INDEX IF EXISTS "TenantMember_userId_idx";
