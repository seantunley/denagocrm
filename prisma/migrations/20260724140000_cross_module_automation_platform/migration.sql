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
