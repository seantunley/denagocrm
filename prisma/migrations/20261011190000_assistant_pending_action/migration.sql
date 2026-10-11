-- Tasks the assistant proposed on WhatsApp, waiting for a Confirm tap. One new
-- table; nothing existing is changed. Additive and re-runnable. Confirming on
-- WhatsApp is OFF for every workspace until its owner turns it on, so applying
-- this changes no behaviour.

CREATE TABLE IF NOT EXISTS "AssistantPendingAction" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "card" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantPendingAction_pkey" PRIMARY KEY ("id")
);
-- For a database that ran an earlier draft of this file (the table existed before these two columns did).
ALTER TABLE "AssistantPendingAction" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "AssistantPendingAction" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3);
-- The daily clean-up deletes by workspace and expiry.
CREATE INDEX IF NOT EXISTS "AssistantPendingAction_tenantId_expiresAt_idx" ON "AssistantPendingAction"("tenantId", "expiresAt");

CREATE INDEX IF NOT EXISTS "AssistantPendingAction_tenantId_userId_createdAt_idx" ON "AssistantPendingAction"("tenantId", "userId", "createdAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. Without it the table fails closed in production.
ALTER TABLE "AssistantPendingAction" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantPendingAction_tenant_isolation" ON "AssistantPendingAction";
CREATE POLICY "AssistantPendingAction_tenant_isolation" ON "AssistantPendingAction"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "AssistantPendingAction" FORCE ROW LEVEL SECURITY;
