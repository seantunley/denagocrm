-- DAX job sheets (roadmap Phase 1, 2026-10-26): one row per piece of work DAX is
-- helping a person with ("quote for Anna: Rover XL, white, delivery R6 500"),
-- so a correction changes one line of it and "continue that quote" the next day,
-- on WhatsApp or in the CRM, picks up the same sheet. Private to the person.
-- Plus the link from a conversation turn to the sheet it touched.
-- Additive only; re-runnable.

ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "taskId" TEXT;

CREATE TABLE IF NOT EXISTS "AssistantTask" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "contactId" TEXT,
  "leadId" TEXT,
  "quoteId" TEXT,
  "details" JSONB NOT NULL,
  "steps" JSONB NOT NULL,
  "nextAction" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "AssistantTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantTask_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantTask_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The person's open sheets, newest activity first (every question reads this).
CREATE INDEX IF NOT EXISTS "AssistantTask_tenantId_userId_status_updatedAt_idx" ON "AssistantTask"("tenantId", "userId", "status", "updatedAt");
-- The nightly close-after-14-days and delete-after-30-days sweep.
CREATE INDEX IF NOT EXISTS "AssistantTask_updatedAt_idx" ON "AssistantTask"("updatedAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES (as every table
-- since the RLS cutover); the policy is what makes the grant safe. Without it
-- the table fails closed in production. One workspace never reads or writes
-- another's sheets.
ALTER TABLE "AssistantTask" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantTask_tenant_isolation" ON "AssistantTask";
CREATE POLICY "AssistantTask_tenant_isolation" ON "AssistantTask"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantTask" FORCE ROW LEVEL SECURITY;
