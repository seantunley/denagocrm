-- Phase C step 2b (C2) — per-tenant PUBLIC API keys (hashed), replacing the single
-- global INTAKE_API_KEY for intake / bookings / service-lookup.
--
-- Additive only: one new table, no changes to existing data. Inert until the routes
-- resolve keys through it; the legacy global INTAKE_API_KEY keeps working (dormant
-- back-compat), so nothing breaks on deploy. Scalar tenantId (no FK), matching the
-- Phase B additive convention — resolution is app-layer and a dangling key simply
-- fails to resolve (fail closed).
--
-- Backfill (register the current global key as the home tenant's key) is a SEPARATE
-- app step run before enforcement (scripts/backfill-tenant-api-keys.ts) — NOT here,
-- since the key value lives in AppSetting, not in this migration.

CREATE TABLE IF NOT EXISTS "TenantApiKey" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "hashedKey" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "scopes" TEXT NOT NULL DEFAULT 'intake,bookings,service-lookup',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "TenantApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantApiKey_hashedKey_key" ON "TenantApiKey"("hashedKey");
CREATE INDEX IF NOT EXISTS "TenantApiKey_tenantId_idx" ON "TenantApiKey"("tenantId");
