-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'automation',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "activeVersion" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Journey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyVersion" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "trigger" TEXT NOT NULL,
    "triggerConfig" JSONB,
    "entryConditions" JSONB,
    "definition" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "JourneyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyEvent" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JourneyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyRun" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "journeyVersionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "currentStepId" TEXT,
    "context" JSONB NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JourneyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyStepLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "stepType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "output" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "JourneyStepLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Journey_status_category_idx" ON "Journey"("status", "category");
CREATE UNIQUE INDEX "JourneyVersion_journeyId_version_key" ON "JourneyVersion"("journeyId", "version");
CREATE INDEX "JourneyVersion_journeyId_state_idx" ON "JourneyVersion"("journeyId", "state");
CREATE INDEX "JourneyVersion_trigger_state_idx" ON "JourneyVersion"("trigger", "state");
CREATE UNIQUE INDEX "JourneyEvent_dedupeKey_key" ON "JourneyEvent"("dedupeKey");
CREATE INDEX "JourneyEvent_status_availableAt_idx" ON "JourneyEvent"("status", "availableAt");
CREATE INDEX "JourneyEvent_type_status_idx" ON "JourneyEvent"("type", "status");
CREATE INDEX "JourneyEvent_journeyId_status_idx" ON "JourneyEvent"("journeyId", "status");
CREATE UNIQUE INDEX "JourneyRun_idempotencyKey_key" ON "JourneyRun"("idempotencyKey");
CREATE INDEX "JourneyRun_status_nextRunAt_idx" ON "JourneyRun"("status", "nextRunAt");
CREATE INDEX "JourneyRun_journeyId_status_idx" ON "JourneyRun"("journeyId", "status");
CREATE INDEX "JourneyRun_entityType_entityId_idx" ON "JourneyRun"("entityType", "entityId");
CREATE INDEX "JourneyRun_leadId_idx" ON "JourneyRun"("leadId");
CREATE INDEX "JourneyRun_contactId_idx" ON "JourneyRun"("contactId");
CREATE UNIQUE INDEX "JourneyStepLog_runId_stepId_key" ON "JourneyStepLog"("runId", "stepId");
CREATE INDEX "JourneyStepLog_runId_startedAt_idx" ON "JourneyStepLog"("runId", "startedAt");
CREATE INDEX "JourneyStepLog_status_startedAt_idx" ON "JourneyStepLog"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "JourneyVersion" ADD CONSTRAINT "JourneyVersion_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JourneyEvent" ADD CONSTRAINT "JourneyEvent_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JourneyRun" ADD CONSTRAINT "JourneyRun_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JourneyRun" ADD CONSTRAINT "JourneyRun_journeyVersionId_fkey" FOREIGN KEY ("journeyVersionId") REFERENCES "JourneyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JourneyStepLog" ADD CONSTRAINT "JourneyStepLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JourneyRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
