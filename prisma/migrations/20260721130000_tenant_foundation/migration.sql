-- Tenant foundation (multi-tenancy PR1). ADDITIVE + BEHAVIOUR-PRESERVING:
-- creates the Tenant / TenantMember tables and a nullable UserSession.tenantId,
-- then seeds ONE tenant for the existing Denago business and backfills every
-- current user + session into it. Nothing reads tenantId yet, so the app runs
-- exactly as before. tenantId on data models + enforcement arrive in later PRs
-- (see MULTITENANCY-SCOPING.md).

-- Tenant
CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_active_idx" ON "Tenant"("active");

-- TenantMember (pure user↔tenant link for now; roles move here later)
CREATE TABLE "TenantMember" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantMember_tenantId_userId_key" ON "TenantMember"("tenantId", "userId");
CREATE INDEX "TenantMember_userId_idx" ON "TenantMember"("userId");
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UserSession.tenantId (nullable, SET NULL on tenant delete)
ALTER TABLE "UserSession" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "UserSession_tenantId_idx" ON "UserSession"("tenantId");
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the founding tenant for the existing Denago business, then backfill every
-- current user as a member and stamp existing sessions. Guarded with ON CONFLICT /
-- IS NULL so the migration is safe to re-run and a no-op on an empty DB.
INSERT INTO "Tenant" ("id", "name", "slug", "active")
VALUES ('tenant_denago_cpt', 'Denago Cape Town', 'denago-cape-town', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "TenantMember" ("id", "tenantId", "userId")
SELECT 'tm_' || "id", 'tenant_denago_cpt', "id" FROM "User"
ON CONFLICT ("tenantId", "userId") DO NOTHING;

UPDATE "UserSession" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
