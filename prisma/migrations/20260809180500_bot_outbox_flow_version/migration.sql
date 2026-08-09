ALTER TABLE "BotFlowOutbox"
  ADD COLUMN "flowVersionId" TEXT;

CREATE INDEX "BotFlowOutbox_tenant_flow_version_status_idx"
  ON "BotFlowOutbox"("tenantId", "flowVersionId", "status");

ALTER TABLE "BotFlowOutbox"
  ADD CONSTRAINT "BotFlowOutbox_flowVersionId_fkey"
  FOREIGN KEY ("flowVersionId") REFERENCES "BotFlowVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
