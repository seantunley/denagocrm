-- Tenant foundation (multi-tenancy PR1). ADDITIVE + BEHAVIOUR-PRESERVING:
-- creates the Tenant / TenantMember tables and a nullable UserSession.tenantId,
-- then seeds ONE tenant for the existing Denago business and backfills every
-- current user + session into it. Nothing reads tenantId yet, so the app runs
-- exactly as before. (Not a no-op on an empty DB: it always creates the Denago
-- tenant — only the user/session backfills no-op when there's no data.) tenantId
-- on data models + enforcement arrive in later PRs (see MULTITENANCY-SCOPING.md).
--
-- REPLAY-SAFE: the runner (scripts/apply-migrations.mjs) executes this file and
-- THEN records it with `migrate resolve` as a separate step. If the file succeeds
-- but recording is interrupted, the next run re-executes it — so every statement
-- must be reentrant. Tables carry their FKs inline (CREATE TABLE IF NOT EXISTS is
-- skipped wholesale on reentry); indexes/columns use IF NOT EXISTS; the one FK on
-- a pre-existing table (UserSession) is guarded via pg_constraint; the data
-- statements already use ON CONFLICT / WHERE IS NULL.

-- Tenant
CREATE TABLE IF NOT EXISTS "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX IF NOT EXISTS "Tenant_active_idx" ON "Tenant"("active");

-- TenantMember (FKs inline so reentry skips them with the table)
CREATE TABLE IF NOT EXISTS "TenantMember" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TenantMember_tenantId_userId_key" ON "TenantMember"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "TenantMember_userId_idx" ON "TenantMember"("userId");

-- UserSession.tenantId (nullable, SET NULL on tenant delete)
ALTER TABLE "UserSession" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
CREATE INDEX IF NOT EXISTS "UserSession_tenantId_idx" ON "UserSession"("tenantId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserSession_tenantId_fkey') THEN
    ALTER TABLE "UserSession"
      ADD CONSTRAINT "UserSession_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Seed the founding tenant for the existing Denago business, then backfill every
-- current user as a member and stamp existing sessions. Idempotent (ON CONFLICT /
-- IS NULL); on reentry these re-run harmlessly and pick up any new rows.
INSERT INTO "Tenant" ("id", "name", "slug", "active")
VALUES ('tenant_denago_cpt', 'Denago Cape Town', 'denago-cape-town', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "TenantMember" ("id", "tenantId", "userId")
SELECT 'tm_' || "id", 'tenant_denago_cpt', "id" FROM "User"
ON CONFLICT ("tenantId", "userId") DO NOTHING;

UPDATE "UserSession" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
