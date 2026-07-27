-- CreateTable
CREATE TABLE "TenantIntegrationCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantIntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantIntegrationCredential_tenantId_key_key" ON "TenantIntegrationCredential"("tenantId", "key");

-- CreateIndex
CREATE INDEX "TenantIntegrationCredential_tenantId_idx" ON "TenantIntegrationCredential"("tenantId");

-- RLS: defence-in-depth — all app reads/writes already go through basePrisma
-- (bypass_rls), but enforce here so a scope-less query can never leak another
-- tenant's credentials in the event of an application error or misconfiguration.
ALTER TABLE "TenantIntegrationCredential" ENABLE ROW LEVEL SECURITY;
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
