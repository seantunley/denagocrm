-- Purpose-built execution ledger for chatbot funnel/drop-off analytics.
-- This is intentionally separate from Communication: a message row cannot tell us
-- which graph node was reached, selected, completed or abandoned.

CREATE TABLE "BotFlowEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "flowVersionId" TEXT,
    "nodeId" TEXT,
    "eventType" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFlowEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BotFlowEvent_tenant_flow_version_idx"
    ON "BotFlowEvent"("tenantId", "flowVersionId", "occurredAt");
CREATE INDEX "BotFlowEvent_tenant_node_event_idx"
    ON "BotFlowEvent"("tenantId", "nodeId", "eventType", "occurredAt");
CREATE INDEX "BotFlowEvent_tenant_conversation_idx"
    ON "BotFlowEvent"("tenantId", "channel", "conversationKey", "occurredAt");

ALTER TABLE "BotFlowEvent"
    ADD CONSTRAINT "BotFlowEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A published version may later be pruned without destroying historic funnel data,
-- so version deletion nulls the reference rather than cascading analytics away.
ALTER TABLE "BotFlowEvent"
    ADD CONSTRAINT "BotFlowEvent_flowVersionId_fkey"
    FOREIGN KEY ("flowVersionId") REFERENCES "BotFlowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BotFlowEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotFlowEvent_tenant_isolation" ON "BotFlowEvent";
CREATE POLICY "BotFlowEvent_tenant_isolation" ON "BotFlowEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BotFlowEvent" FORCE ROW LEVEL SECURITY;
