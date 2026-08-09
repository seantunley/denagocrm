-- A channel participant id is not globally unique across CRM tenants. The same
-- customer can message two different tenant-owned WhatsApp numbers / Meta pages.
DROP INDEX IF EXISTS "BotSession_channel_key_key";
CREATE UNIQUE INDEX "BotSession_tenant_channel_key_key"
  ON "BotSession"("tenantId", "channel", "key");
