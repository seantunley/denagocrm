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
UPDATE "GoogleReview" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

-- 2. Swap the global key for the tenant-scoped one. The new index cannot reject
--    anything the dropped constraint was already rejecting.
DROP INDEX IF EXISTS "GoogleReview_externalKey_key";
CREATE UNIQUE INDEX IF NOT EXISTS "GoogleReview_tenantId_externalKey_key" ON "GoogleReview" ("tenantId", "externalKey");
