-- Business-name uniqueness → per-tenant.
--
-- Tag.name, SupportTag.slug and SupportMailbox.slug were GLOBALLY unique. That
-- directly breaks multi-tenancy: once a second tenant exists, the first tenant
-- to use a given tag name / slug permanently blocks every other tenant from
-- using it — and the unique-violation error itself leaks that the value already
-- exists in some other tenant. Move each to a composite (tenantId, <col>) unique
-- index so the value is unique WITHIN a tenant, and lock tenantId NOT NULL so a
-- NULL row can never silently sidestep the composite (NULLs compare distinct).
--
-- The backfill is provably collision-free: the OLD global unique guaranteed at
-- most ONE row per value across ALL tenants, so adopting every NULL/legacy-global
-- row into the founding tenant can never create a duplicate (tenantId, value).
--
-- These three tables' RLS policies never admitted `tenantId IS NULL` (unlike the
-- Role/RolePermission shared pair), so a NULL row is already invisible under
-- enforcement — NOT NULL just makes that explicit and fail-closed. No policy
-- change is needed.
--
-- Replay-safe: idempotent UPDATE, SET NOT NULL is a no-op when already set, and
-- the index swaps guard with IF EXISTS / IF NOT EXISTS.

-- ── Tag (CRM contact tags) ───────────────────────────────────────────────────
UPDATE "Tag" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
ALTER TABLE "Tag" ALTER COLUMN "tenantId" SET NOT NULL;
DROP INDEX IF EXISTS "Tag_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Tag_tenantId_name_key" ON "Tag" ("tenantId", "name");

-- ── SupportTag (help-desk ticket tags) ───────────────────────────────────────
UPDATE "SupportTag" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
ALTER TABLE "SupportTag" ALTER COLUMN "tenantId" SET NOT NULL;
DROP INDEX IF EXISTS "SupportTag_slug_key";
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTag_tenantId_slug_key" ON "SupportTag" ("tenantId", "slug");

-- ── SupportMailbox (help-desk mailboxes) ─────────────────────────────────────
-- Only `slug` (a name-derived URL key) moves to per-tenant. `email` stays
-- GLOBALLY unique — it is the inbound routing key: a message to one address must
-- resolve to exactly one mailbox across the whole platform, so two tenants may
-- NOT claim the same inbound address.
UPDATE "SupportMailbox" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
ALTER TABLE "SupportMailbox" ALTER COLUMN "tenantId" SET NOT NULL;
DROP INDEX IF EXISTS "SupportMailbox_slug_key";
CREATE UNIQUE INDEX IF NOT EXISTS "SupportMailbox_tenantId_slug_key" ON "SupportMailbox" ("tenantId", "slug");
