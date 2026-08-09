-- Upgrade the original insert-once dedupe fence into a leased processing ledger.
-- Existing rows represent events that were already accepted before this rollout,
-- so mark them completed rather than making old provider ids replayable.
ALTER TABLE "BotInboundEvent"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "BotInboundEvent"
   SET "completedAt" = COALESCE("completedAt", "createdAt"),
       "updatedAt" = COALESCE("updatedAt", "createdAt")
 WHERE "status" = 'completed';

-- New inserts should begin as running leases. The application always supplies
-- status explicitly, but changing the default keeps direct/schema-created rows
-- consistent with the model contract.
ALTER TABLE "BotInboundEvent" ALTER COLUMN "status" SET DEFAULT 'running';

CREATE INDEX "BotInboundEvent_tenant_status_lease_idx"
  ON "BotInboundEvent"("tenantId", "status", "leaseUntil");
