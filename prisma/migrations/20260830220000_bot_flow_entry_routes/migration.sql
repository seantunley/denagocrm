-- Route new conversations to a published flow by channel plus an explicit entry
-- signal. Existing BotFlowPublication rows remain the default/fallback route.
CREATE UNIQUE INDEX IF NOT EXISTS "BotFlow_tenantId_id_key" ON "BotFlow"("tenantId", "id");

CREATE TABLE IF NOT EXISTS "BotFlowRoute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFlowRoute_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotFlowRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotFlowRoute_tenant_flow_fkey" FOREIGN KEY ("tenantId", "flowId") REFERENCES "BotFlow"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotFlowRoute_channel_check" CHECK ("channel" IN ('whatsapp','messenger','instagram','telegram')),
    CONSTRAINT "BotFlowRoute_kind_check" CHECK ("kind" IN ('keyword','referral','ad')),
    CONSTRAINT "BotFlowRoute_pattern_check" CHECK (length(btrim("pattern")) BETWEEN 2 AND 180),
    CONSTRAINT "BotFlowRoute_priority_check" CHECK ("priority" BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX IF NOT EXISTS "BotFlowRoute_tenantId_channel_kind_pattern_key"
    ON "BotFlowRoute"("tenantId", "channel", "kind", "pattern");
CREATE INDEX IF NOT EXISTS "BotFlowRoute_tenantId_channel_enabled_priority_idx"
    ON "BotFlowRoute"("tenantId", "channel", "enabled", "priority");
CREATE INDEX IF NOT EXISTS "BotFlowRoute_tenantId_flowId_idx"
    ON "BotFlowRoute"("tenantId", "flowId");

ALTER TABLE "BotFlowRoute" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotFlowRoute_tenant_isolation" ON "BotFlowRoute";
CREATE POLICY "BotFlowRoute_tenant_isolation" ON "BotFlowRoute"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "BotFlowRoute" FORCE ROW LEVEL SECURITY;
