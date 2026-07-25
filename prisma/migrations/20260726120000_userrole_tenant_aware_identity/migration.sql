-- UserRole: tenant-aware identity. ADDITIVE + REPLAY-SAFE.
--
-- Roles are GLOBAL (one shared permission taxonomy), but a user may belong to
-- more than one tenant, so the ASSIGNMENT of a role to a user must be unique
-- PER TENANT — the same (userId, roleId) may legitimately recur across tenants.
-- The old primary key (userId, roleId) forbids that. tenantId is nullable
-- (Phase B — additive/inert) and Postgres/Prisma forbid a nullable column in a
-- primary key, so we cannot simply extend the composite PK. Instead:
--   1. add a surrogate `id` PK, and
--   2. move per-assignment uniqueness to (tenantId, userId, roleId).
-- Nothing reads tenantId yet (enforcement is off); this only changes identity.
--
-- Every statement uses IF [NOT] EXISTS / DROP ... IF EXISTS so the whole file is
-- idempotent and can be re-run without error.

-- gen_random_uuid() is core in PG13+, but ensure pgcrypto too so the backfill
-- works even on older/edge builds. Guarded, so replay-safe.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Surrogate id column (nullable first so we can backfill existing rows).
ALTER TABLE "UserRole" ADD COLUMN IF NOT EXISTS "id" TEXT;

-- 2. Backfill existing rows with a generated id. WHERE "id" IS NULL keeps replay
--    a no-op once every row already has one.
UPDATE "UserRole" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;

-- 3. Lock it down: id is now required.
ALTER TABLE "UserRole" ALTER COLUMN "id" SET NOT NULL;

-- 4. Swap the composite PK for the surrogate PK. DROP IF EXISTS first so both the
--    original composite PK (first run) and the surrogate PK (replay) are removed
--    before re-adding — ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so the
--    preceding DROP is what makes this idempotent.
ALTER TABLE "UserRole" DROP CONSTRAINT IF EXISTS "UserRole_pkey";
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id");

-- 5. Tenant-aware uniqueness of an assignment. Name matches Prisma's
--    @@unique([tenantId, userId, roleId]) => "UserRole_tenantId_userId_roleId_key"
--    so schema and database agree.
CREATE UNIQUE INDEX IF NOT EXISTS "UserRole_tenantId_userId_roleId_key" ON "UserRole"("tenantId", "userId", "roleId");
