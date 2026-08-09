-- Lead.externalId is the durable creation identity a provider retry looks up, but
-- it was UNIQUE across the WHOLE table while every lookup that consults it is
-- scoped to one tenant. The two disagreed about what "already created" means:
-- a collision owned by another tenant raised a P2002 that the tenant-scoped read
-- could never resolve, so the caller replayed it for ever.
--
-- A provider id is unique to the provider, not to us. Two tenants may legitimately
-- receive the same Facebook leadgen_id, so the identity belongs to (tenant, id).
--
-- Every statement is reentrant, so re-applying this migration is a no-op.

-- 1. No tenant-owned Lead may be tenantless. The Phase B isolation migration did
--    this once, but the db.ts guard only stamps tenantId under enforcement — which
--    is still dormant — so Leads created since then were written with a NULL
--    tenantId. Those rows are invisible to the tenant-scoped identity read, and
--    would also be invisible to RLS once enforcement flips on.
UPDATE "Lead" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

-- 2. Swap the global identity for the tenant-scoped one. Order matters only for
--    clarity: the new index cannot conflict, because anything it would reject was
--    already rejected by the global constraint being dropped.
DROP INDEX IF EXISTS "Lead_externalId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_tenantId_externalId_key" ON "Lead" ("tenantId", "externalId");
