-- DAX conversations (Sean, 2026-11-13): questions belong to a conversation that can be picked up again, one per
-- customer or deal when asked on their page, with a running summary of what has fallen out of the last six
-- exchanges. Additive only: a new table and a nullable column; existing turns keep conversationId NULL and show as
-- "Earlier". No data is moved.

CREATE TABLE IF NOT EXISTS "AssistantConversation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "leadId" TEXT,
  "contactId" TEXT,
  "summary" TEXT,
  "summarizedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantConversation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantConversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantConversation_tenantId_userId_updatedAt_idx" ON "AssistantConversation"("tenantId", "userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "AssistantConversation_tenantId_userId_leadId_idx" ON "AssistantConversation"("tenantId", "userId", "leadId");
CREATE INDEX IF NOT EXISTS "AssistantConversation_tenantId_userId_contactId_idx" ON "AssistantConversation"("tenantId", "userId", "contactId");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is what makes the grant safe.
ALTER TABLE "AssistantConversation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantConversation_tenant_isolation" ON "AssistantConversation";
CREATE POLICY "AssistantConversation_tenant_isolation" ON "AssistantConversation"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantConversation" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;
CREATE INDEX IF NOT EXISTS "AssistantTurn_conversationId_createdAt_idx" ON "AssistantTurn"("conversationId", "createdAt");
