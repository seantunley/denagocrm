-- Cross-module automation platform foundation.
-- Additive and replay-safe: used by the repository's unified migration runner.

ALTER TABLE "Journey" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyVersion" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyEvent" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyRun" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "JourneyStepLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "JourneyVersion" v SET "tenantId" = j."tenantId"
FROM "Journey" j WHERE v."journeyId" = j."id" AND v."tenantId" IS NULL;
UPDATE "JourneyEvent" e SET "tenantId" = j."tenantId"
FROM "Journey" j WHERE e."journeyId" = j."id" AND e."tenantId" IS NULL;
UPDATE "JourneyRun" r SET "tenantId" = j."tenantId"
FROM "Journey" j WHERE r."journeyId" = j."id" AND r."tenantId" IS NULL;
UPDATE "JourneyStepLog" l SET "tenantId" = r."tenantId"
FROM "JourneyRun" r WHERE l."runId" = r."id" AND l."tenantId" IS NULL;

CREATE INDEX IF NOT EXISTS "Journey_tenantId_idx" ON "Journey"("tenantId");
CREATE INDEX IF NOT EXISTS "Journey_tenantId_status_category_idx" ON "Journey"("tenantId", "status", "category");
CREATE INDEX IF NOT EXISTS "JourneyVersion_tenantId_idx" ON "JourneyVersion"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyVersion_tenantId_trigger_state_idx" ON "JourneyVersion"("tenantId", "trigger", "state");
CREATE INDEX IF NOT EXISTS "JourneyEvent_tenantId_idx" ON "JourneyEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyEvent_tenantId_status_availableAt_idx" ON "JourneyEvent"("tenantId", "status", "availableAt");
CREATE INDEX IF NOT EXISTS "JourneyEvent_tenantId_type_status_idx" ON "JourneyEvent"("tenantId", "type", "status");
CREATE INDEX IF NOT EXISTS "JourneyRun_tenantId_idx" ON "JourneyRun"("tenantId");
CREATE INDEX IF NOT EXISTS "JourneyRun_tenantId_status_nextRunAt_idx" ON "JourneyRun"("tenantId", "status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "JourneyStepLog_tenantId_idx" ON "JourneyStepLog"("tenantId");

CREATE TABLE IF NOT EXISTS "AutomationOutbox" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "entityType" TEXT,
  "entityId" TEXT,
  "journeyRunId" TEXT,
  "journeyStepId" TEXT,
  "payload" JSONB NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomationOutbox_status_check" CHECK ("status" IN ('pending','processing','completed','failed','blocked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationOutbox_idempotencyKey_key" ON "AutomationOutbox"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AutomationOutbox_tenantId_idx" ON "AutomationOutbox"("tenantId");
CREATE INDEX IF NOT EXISTS "AutomationOutbox_tenantId_status_availableAt_idx" ON "AutomationOutbox"("tenantId", "status", "availableAt");
CREATE INDEX IF NOT EXISTS "AutomationOutbox_kind_status_idx" ON "AutomationOutbox"("kind", "status");
CREATE INDEX IF NOT EXISTS "AutomationOutbox_journeyRunId_idx" ON "AutomationOutbox"("journeyRunId");

CREATE TABLE IF NOT EXISTS "AutomationApprovalRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "title" TEXT NOT NULL,
  "description" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "contactId" TEXT,
  "leadId" TEXT,
  "requestedById" TEXT,
  "assignedToId" TEXT,
  "journeyRunId" TEXT,
  "journeyStepId" TEXT,
  "metadata" JSONB,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationApprovalRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomationApprovalRequest_status_check" CHECK ("status" IN ('pending','approved','rejected','cancelled'))
);
CREATE INDEX IF NOT EXISTS "AutomationApprovalRequest_tenantId_idx" ON "AutomationApprovalRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "AutomationApprovalRequest_tenantId_status_assignedToId_idx" ON "AutomationApprovalRequest"("tenantId", "status", "assignedToId");
CREATE INDEX IF NOT EXISTS "AutomationApprovalRequest_journeyRunId_idx" ON "AutomationApprovalRequest"("journeyRunId");
CREATE INDEX IF NOT EXISTS "AutomationApprovalRequest_contactId_idx" ON "AutomationApprovalRequest"("contactId");
CREATE INDEX IF NOT EXISTS "AutomationApprovalRequest_leadId_idx" ON "AutomationApprovalRequest"("leadId");

CREATE TABLE IF NOT EXISTS "StockTransferRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "stockUnitId" TEXT NOT NULL,
  "fromBranch" TEXT,
  "toBranch" TEXT NOT NULL,
  "notes" TEXT,
  "requestedById" TEXT,
  "journeyRunId" TEXT,
  "journeyStepId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockTransferRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockTransferRequest_status_check" CHECK ("status" IN ('requested','approved','in_transit','received','cancelled'))
);
CREATE INDEX IF NOT EXISTS "StockTransferRequest_tenantId_idx" ON "StockTransferRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "StockTransferRequest_tenantId_status_toBranch_idx" ON "StockTransferRequest"("tenantId", "status", "toBranch");
CREATE INDEX IF NOT EXISTS "StockTransferRequest_stockUnitId_status_idx" ON "StockTransferRequest"("stockUnitId", "status");
CREATE INDEX IF NOT EXISTS "StockTransferRequest_journeyRunId_idx" ON "StockTransferRequest"("journeyRunId");

-- StockEvent is the operational source of truth. Mirror only the four requested
-- lifecycle events into the durable JourneyEvent queue, in the same transaction
-- as the StockEvent insert. No financial fields are copied into automation payloads.
CREATE OR REPLACE FUNCTION enqueue_stock_automation_event() RETURNS trigger AS $$
DECLARE
  trigger_name TEXT;
  target_type TEXT := 'system';
  target_id TEXT;
  quote_lead TEXT;
  quote_contact TEXT;
BEGIN
  IF NEW."eventType" = 'goods.received' THEN
    trigger_name := 'stock_received';
  ELSIF NEW."eventType" = 'goods.inspected' AND NEW."toStatus" = 'damaged' THEN
    trigger_name := 'stock_inspection_failed';
  ELSIF NEW."eventType" = 'pdi.completed' AND NEW."toStatus" = 'ready_for_delivery' THEN
    trigger_name := 'pdi_passed';
  ELSIF NEW."eventType" = 'pdi.completed' AND NEW."toStatus" = 'hold' THEN
    trigger_name := 'pdi_failed';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW."leadId" IS NOT NULL THEN
    target_type := 'lead';
    target_id := NEW."leadId";
  ELSIF NEW."quoteId" IS NOT NULL THEN
    SELECT "leadId", "contactId" INTO quote_lead, quote_contact FROM "Quote" WHERE "id" = NEW."quoteId";
    IF quote_lead IS NOT NULL THEN
      target_type := 'lead'; target_id := quote_lead;
    ELSIF quote_contact IS NOT NULL THEN
      target_type := 'contact'; target_id := quote_contact;
    END IF;
  END IF;

  IF target_id IS NULL THEN
    target_id := COALESCE(NEW."stockUnitId", NEW."purchaseOrderId", NEW."id");
  END IF;

  INSERT INTO "JourneyEvent" (
    "id", "tenantId", "type", "entityType", "entityId", "payload", "status",
    "attempts", "availableAt", "dedupeKey", "createdAt", "updatedAt"
  ) VALUES (
    'je_stock_' || SUBSTRING(md5(NEW."id" || trigger_name) FROM 1 FOR 22),
    NEW."tenantId", trigger_name, target_type, target_id,
    jsonb_build_object(
      'status', NEW."toStatus",
      'sourceId', COALESCE(NEW."stockUnitId", NEW."purchaseOrderId", NEW."id"),
      'source', jsonb_build_object(
        'id', NEW."id", 'stockUnitId', NEW."stockUnitId", 'purchaseOrderId', NEW."purchaseOrderId",
        'eventType', NEW."eventType", 'fromStatus', NEW."fromStatus", 'toStatus', NEW."toStatus",
        'reason', NEW."reason", 'detail', NEW."detail"
      )
    ),
    'pending', 0, CURRENT_TIMESTAMP, 'stock:' || NEW."id" || ':' || trigger_name,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ) ON CONFLICT ("dedupeKey") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "StockEvent_enqueue_automation" ON "StockEvent";
CREATE TRIGGER "StockEvent_enqueue_automation"
AFTER INSERT ON "StockEvent"
FOR EACH ROW EXECUTE FUNCTION enqueue_stock_automation_event();
