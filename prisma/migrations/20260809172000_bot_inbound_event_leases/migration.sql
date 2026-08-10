-- Upgrade the original insert-once dedupe fence into a leased processing ledger.
-- Existing rows represent events that were already accepted before this rollout,
-- so mark them completed rather than making old provider ids replayable.
--
-- EVERY STATEMENT HERE IS REENTRANT, and that is not decoration.
--
-- 20260809144000 exists as two different files under the same directory name
-- across this stack: the branches from #398 up to #422 create "BotInboundEvent"
-- WITH these lease columns already on it, while #423 upward create the bare table
-- and rely on this migration to add them. Whichever shape wins a merge, the
-- directory name is the same, so Prisma records it as applied once and never
-- reconciles the difference. A bare `ADD COLUMN` therefore hits 42701 on half the
-- possible merge orders, and the index name hits 42P07 — a dead deploy that no
-- individual PR's CI can see, because each branch holds only one of the shapes.
--
-- It also matters beyond the merge. Preview-branch migrations have reached this
-- project's production database before, and its migration runner has previously
-- marked a migration applied whose SQL never ran (P2022) — so a partially applied
-- or already-applied state has to be re-drivable by hand rather than fatal.
ALTER TABLE "BotInboundEvent"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastError" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "BotInboundEvent"
   SET "completedAt" = COALESCE("completedAt", "createdAt"),
       "updatedAt" = COALESCE("updatedAt", "createdAt")
 WHERE "status" = 'completed';

-- New inserts should begin as running leases. The application always supplies
-- status explicitly, but changing the default keeps direct/schema-created rows
-- consistent with the model contract. Idempotent by nature — setting the same
-- default twice is a no-op.
ALTER TABLE "BotInboundEvent" ALTER COLUMN "status" SET DEFAULT 'running';

CREATE INDEX IF NOT EXISTS "BotInboundEvent_tenant_status_lease_idx"
  ON "BotInboundEvent"("tenantId", "status", "leaseUntil");
