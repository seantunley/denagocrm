-- Make the two SalesPipeline unique indexes PER TENANT.
--
-- Both were global, and the second one is a hard blocker for multi-tenancy rather
-- than a leak. Found by the two-tenant runtime harness (PR #468), confirmed against
-- production:
--
--   SalesPipeline_name_key           UNIQUE (name)      WHERE deletedAt IS NULL
--   SalesPipeline_single_default_key UNIQUE (isDefault) WHERE isDefault = true
--                                                         AND deletedAt IS NULL
--
-- The second indexes a single boolean across the WHOLE table, so exactly ONE row in
-- the entire database may have isDefault = true. Tenant B can therefore never have
-- a default pipeline: the insert fails on tenant A's row. No amount of query
-- scoping fixes that — it is the schema refusing the second tenant.
--
-- The first is milder but the same shape: two tenants cannot both have a pipeline
-- called "Sales Pipeline", which is the name the seed uses.
--
-- Note on NULL tenantId: Postgres treats NULLs as distinct in a unique index, so
-- unowned rows never collide with each other or with an owned row. That is the
-- behaviour we want during the dormant period — it cannot block a write — and it
-- is why this migration is safe to apply before the backfill.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode. Every statement is IF EXISTS / IF NOT EXISTS.

-- Drop the global versions.
DROP INDEX IF EXISTS "SalesPipeline_name_key";
DROP INDEX IF EXISTS "SalesPipeline_single_default_key";

-- One pipeline name per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "SalesPipeline_tenantId_name_key"
  ON "SalesPipeline" ("tenantId", "name")
  WHERE "deletedAt" IS NULL;

-- One default pipeline per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "SalesPipeline_tenantId_single_default_key"
  ON "SalesPipeline" ("tenantId", "isDefault")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;
