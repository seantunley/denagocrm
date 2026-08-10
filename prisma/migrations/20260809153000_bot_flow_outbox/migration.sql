-- Durable chatbot outbound delivery queue.
CREATE TABLE IF NOT EXISTS "BotFlowOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "actorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "communicationLoggedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFlowOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotFlowOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BotFlowOutbox_tenant_batch_sequence_key"
    ON "BotFlowOutbox"("tenantId", "batchId", "sequence");
CREATE INDEX IF NOT EXISTS "BotFlowOutbox_tenant_status_available_idx"
    ON "BotFlowOutbox"("tenantId", "status", "availableAt");
CREATE INDEX IF NOT EXISTS "BotFlowOutbox_tenant_channel_key_created_idx"
    ON "BotFlowOutbox"("tenantId", "channel", "key", "createdAt", "sequence");
CREATE INDEX IF NOT EXISTS "BotFlowOutbox_tenant_status_log_idx"
    ON "BotFlowOutbox"("tenantId", "status", "communicationLoggedAt");

ALTER TABLE "BotFlowOutbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotFlowOutbox_tenant_isolation" ON "BotFlowOutbox";
CREATE POLICY "BotFlowOutbox_tenant_isolation" ON "BotFlowOutbox"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "BotFlowOutbox" FORCE ROW LEVEL SECURITY;
