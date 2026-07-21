-- Tenant foundation (multi-tenancy PR1). ADDITIVE + BEHAVIOUR-PRESERVING:
-- creates the Organization / OrganizationMembership tables and a nullable
-- UserSession.organizationId, then seeds ONE org for the existing Denago business
-- and backfills every current user + session into it. Nothing reads organizationId
-- yet, so the app runs exactly as before. tenantId on data models + enforcement
-- arrive in later PRs (see MULTITENANCY-SCOPING.md).

-- Organization
CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_active_idx" ON "Organization"("active");

-- OrganizationMembership (pure user↔org link for now; roles move here later)
CREATE TABLE "OrganizationMembership" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UserSession.organizationId (nullable, SET NULL on org delete)
ALTER TABLE "UserSession" ADD COLUMN "organizationId" TEXT;
CREATE INDEX "UserSession_organizationId_idx" ON "UserSession"("organizationId");
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the founding organization for the existing Denago business, then backfill
-- every current user as a member and stamp existing sessions. Guarded with ON
-- CONFLICT / IS NULL so the migration is safe to re-run and a no-op on an empty DB.
INSERT INTO "Organization" ("id", "name", "slug", "active")
VALUES ('org_denago_cpt', 'Denago Cape Town', 'denago-cape-town', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "OrganizationMembership" ("id", "organizationId", "userId")
SELECT 'mem_' || "id", 'org_denago_cpt', "id" FROM "User"
ON CONFLICT ("organizationId", "userId") DO NOTHING;

UPDATE "UserSession" SET "organizationId" = 'org_denago_cpt' WHERE "organizationId" IS NULL;
