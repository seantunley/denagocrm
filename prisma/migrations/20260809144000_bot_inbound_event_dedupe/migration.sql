-- Durable webhook retry fence for chatbot-driving inbound provider events.
CREATE TABLE IF NOT EXISTS "BotInboundEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotInboundEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotInboundEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BotInboundEvent_tenant_channel_provider_key"
    ON "BotInboundEvent"("tenantId", "channel", "providerId");
CREATE INDEX IF NOT EXISTS "BotInboundEvent_createdAt_idx" ON "BotInboundEvent"("createdAt");

ALTER TABLE "BotInboundEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotInboundEvent_tenant_isolation" ON "BotInboundEvent";
CREATE POLICY "BotInboundEvent_tenant_isolation" ON "BotInboundEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BotInboundEvent" FORCE ROW LEVEL SECURITY;
