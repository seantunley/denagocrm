-- Purpose-built execution ledger for chatbot funnel/drop-off analytics.
-- This is intentionally separate from Communication: a message row cannot tell us
-- which graph node was reached, selected, completed or abandoned.

CREATE TABLE IF NOT EXISTS "BotFlowEvent" (
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

CREATE INDEX IF NOT EXISTS "BotFlowEvent_tenant_flow_version_idx"
    ON "BotFlowEvent"("tenantId", "flowVersionId", "occurredAt");
CREATE INDEX IF NOT EXISTS "BotFlowEvent_tenant_node_event_idx"
    ON "BotFlowEvent"("tenantId", "nodeId", "eventType", "occurredAt");
CREATE INDEX IF NOT EXISTS "BotFlowEvent_tenant_conversation_idx"
    ON "BotFlowEvent"("tenantId", "channel", "conversationKey", "occurredAt");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and the migration runner opens no
-- transaction, so a re-run after a partial application must not die on 42710.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BotFlowEvent_tenantId_fkey') THEN
    ALTER TABLE "BotFlowEvent"
      ADD CONSTRAINT "BotFlowEvent_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- A published version may later be pruned without destroying historic funnel
  -- data, so version deletion nulls the reference rather than cascading analytics
  -- away.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BotFlowEvent_flowVersionId_fkey') THEN
    ALTER TABLE "BotFlowEvent"
      ADD CONSTRAINT "BotFlowEvent_flowVersionId_fkey"
      FOREIGN KEY ("flowVersionId") REFERENCES "BotFlowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

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
