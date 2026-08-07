-- Verification state for a tenant's outbound integrations: whether the stored
-- credentials were last seen actually working against the provider.
--
-- Additive and inert. Holds NO credential material — TenantIntegrationCredential
-- remains the only store for secrets, and every existing credential read
-- (resolveTenantCredential / resolveIntegrationBundle) ignores this table. An
-- install with zero rows behaves exactly as it does today; a missing row simply
-- means "never verified".
--
-- Scalar tenantId, no FK — same convention as TenantIntegrationCredential and
-- TenantApiKey: resolution is app-layer, so a dangling tenantId fails closed to
-- "never verified" instead of raising a DB error.
--
-- Timestamp prefix (not a small integer) so apply-migrations.mjs, which orders
-- by Number.parseInt of the directory name, runs this AFTER every numeric-prefix
-- migration including 80_tenant_integration_credentials.
--
-- Idempotent throughout (IF NOT EXISTS): apply-migrations.mjs is execute-then-
-- record, so a migration that fails after partial execution is retried whole.

CREATE TABLE IF NOT EXISTS "IntegrationConnection" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "lastVerifiedAt" TIMESTAMP(3),
  "blameStep" TEXT,
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "lastErrorText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- One verification state per (tenant, integration). Also the conflict target for
-- the upsert in src/lib/integrationConnection.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationConnection_tenantId_integrationId_key"
  ON "IntegrationConnection"("tenantId", "integrationId");

CREATE INDEX IF NOT EXISTS "IntegrationConnection_tenantId_idx"
  ON "IntegrationConnection"("tenantId");

-- Serves the settings page's "which of this tenant's integrations need
-- attention" read, which filters on status within a tenant.
CREATE INDEX IF NOT EXISTS "IntegrationConnection_tenantId_status_idx"
  ON "IntegrationConnection"("tenantId", "status");

-- RLS. FORCE ROW LEVEL SECURITY has been live since 20260727130000_rls_enforce,
-- so a tenant-owned table added after it without a policy has no DB-layer
-- boundary at all — only the app guard, which src/lib/db.ts documents as
-- defence-in-depth rather than the authoritative one. Every other tenant table
-- added since carries this exact block; this one must too.
--
-- No `OR "tenantId" IS NULL` escape hatch. Unlike Role/RolePermission there is
-- no such thing as a shared, tenantless integration connection — the column is
-- NOT NULL precisely so there never can be — and a NULL-matching clause would
-- be a hole rather than a convenience.
--
-- The bypass clause is the same one every other policy uses, so the platform
-- console and the backup job keep working through withSystemScope.
ALTER TABLE "IntegrationConnection" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "IntegrationConnection_tenant_isolation" ON "IntegrationConnection";
CREATE POLICY "IntegrationConnection_tenant_isolation" ON "IntegrationConnection"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "IntegrationConnection" FORCE ROW LEVEL SECURITY;
