-- Per-tenant OVERRIDE credentials for outbound integrations (WhatsApp, Meta,
-- Telegram, SMTP, IMAP, SMS, Google Reviews). Additive only: AppSetting stays
-- the sole GLOBAL credential store, and this table starts empty, so
-- resolveTenantCredential's fallback to AppSetting (src/lib/settings.ts) is
-- exactly today's single-tenant behaviour until a tenant saves an override.
-- Scalar tenantId, no FK — matches the TenantApiKey / ChannelIdentity
-- convention (app-layer resolution, fails closed to the global row).

CREATE TABLE IF NOT EXISTS "TenantIntegrationCredential" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantIntegrationCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantIntegrationCredential_tenantId_key_key"
  ON "TenantIntegrationCredential"("tenantId", "key");

CREATE INDEX IF NOT EXISTS "TenantIntegrationCredential_tenantId_idx"
  ON "TenantIntegrationCredential"("tenantId");
