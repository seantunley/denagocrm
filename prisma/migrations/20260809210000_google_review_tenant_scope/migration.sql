-- GoogleReview is tenant-owned data, but its natural key was UNIQUE across the
-- whole table while the sync that consults it belongs to one tenant. Two tenants
-- watching the same Google Place produce the same externalKey (a hash of author
-- and publish time), so whoever synced first silently suppressed the other's
-- copy of the review — and a scoped dedupe read against a global constraint
-- would turn that suppression into a unique-violation crash instead.
--
-- Every statement is reentrant, so re-applying this migration is a no-op.

-- 1. No tenant-owned review may be tenantless. The sync stamped
--    `currentTenantScope()?.tenantId ?? null`, and the scope is empty while
--    enforcement is dormant, so rows written so far carry NULL.
--
-- GoogleReview carries FORCE ROW LEVEL SECURITY. Where the migrating role does
-- not bypass RLS, an unwrapped backfill matches ZERO rows, SUCCEEDS, and is
-- recorded as applied — the exact "recorded but never really ran" shape behind
-- this project's earlier P2022 outage. Here it would be worse than a no-op: step
-- 2 then builds the tenant-scoped unique index over rows whose tenantId is still
-- NULL, and NULLs do not conflict in a unique index, so the duplicate this
-- migration exists to prevent would be admitted by the very constraint meant to
-- stop it. Same escape hatch basePrisma uses, and the same wrapping as the
-- sibling Lead.externalId migration.
SET app.bypass_rls = 'on';
UPDATE "GoogleReview" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

-- 2. Swap the global key for the tenant-scoped one. The new index cannot reject
--    anything the dropped constraint was already rejecting.
DROP INDEX IF EXISTS "GoogleReview_externalKey_key";
CREATE UNIQUE INDEX IF NOT EXISTS "GoogleReview_tenantId_externalKey_key" ON "GoogleReview" ("tenantId", "externalKey");
RESET app.bypass_rls;
