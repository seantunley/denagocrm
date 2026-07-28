-- Option A: one-user-one-tenant policy.
-- A user may belong to at most one tenant. This is enforced at the DB level
-- with a unique constraint on TenantMember.userId. The app layer raises a
-- friendly error before this fires; the constraint is the safety net.
--
-- Safety check: abort if any user already has multiple memberships (should not
-- exist in practice — new tenants provision fresh dedicated users).
DO $$
BEGIN
  IF EXISTS (
    SELECT "userId" FROM "TenantMember" GROUP BY "userId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce single-tenant policy: users with multiple memberships exist. Resolve manually first.';
  END IF;
END $$;

-- Drop the now-redundant plain index on userId (the unique constraint below
-- creates its own index).
DROP INDEX IF EXISTS "TenantMember_userId_idx";

CREATE UNIQUE INDEX "TenantMember_userId_key" ON "TenantMember"("userId");
