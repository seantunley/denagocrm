-- Workflow approval gates: internal approve/reject steps + runtime interpreter state.
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "workflowGraphJson" JSONB;
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "currentNodeId" TEXT;
-- Links a recipient to the workflow signer node it was materialised from.
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "nodeId" TEXT;

CREATE TABLE IF NOT EXISTS "ApprovalStep" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'decision',
  "assigneeType" TEXT NOT NULL,
  "assigneeUserId" TEXT,
  "assigneeRole" TEXT,
  "assigneeName" TEXT,
  "assigneeEmail" TEXT,
  "token" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedByUserId" TEXT,
  "decidedByName" TEXT,
  "decidedAt" TIMESTAMP(3),
  "reason" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApprovalStep_token_key" ON "ApprovalStep"("token");
CREATE INDEX IF NOT EXISTS "ApprovalStep_requestId_idx" ON "ApprovalStep"("requestId");
CREATE INDEX IF NOT EXISTS "ApprovalStep_status_idx" ON "ApprovalStep"("status");

DO $$ BEGIN
  ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
