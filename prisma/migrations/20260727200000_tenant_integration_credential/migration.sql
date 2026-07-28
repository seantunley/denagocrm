-- RLS for TenantIntegrationCredential (table created by migration 80_tenant_integration_credentials).
-- All app reads/writes already go through basePrisma (bypass_rls); this is defence-in-depth
-- so a scope-less query can never leak another tenant's credentials in the event of an
-- application error or misconfiguration.
ALTER TABLE "TenantIntegrationCredential" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantIntegrationCredential_tenant_isolation_placeholder" ON "TenantIntegrationCredential";
DROP POLICY IF EXISTS "TenantIntegrationCredential_tenant_isolation" ON "TenantIntegrationCredential";
CREATE POLICY "TenantIntegrationCredential_tenant_isolation" ON "TenantIntegrationCredential"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantIntegrationCredential" FORCE ROW LEVEL SECURITY;
