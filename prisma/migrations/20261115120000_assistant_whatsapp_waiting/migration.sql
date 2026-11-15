-- WhatsApp messages sent seconds apart are answered as one question (Sean, 2026-11-15). A typed message waits a
-- few seconds here in case the next one belongs with it. Additive only: one new table, no existing data touched.

CREATE TABLE IF NOT EXISTS "AssistantWhatsAppWaiting" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL,
  "claimedBy" TEXT,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantWhatsAppWaiting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantWhatsAppWaiting_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantWhatsAppWaiting_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantWhatsAppWaiting_tenantId_messageId_key" ON "AssistantWhatsAppWaiting"("tenantId", "messageId");
CREATE INDEX IF NOT EXISTS "AssistantWhatsAppWaiting_tenantId_userId_sentAt_idx" ON "AssistantWhatsAppWaiting"("tenantId", "userId", "sentAt");
CREATE INDEX IF NOT EXISTS "AssistantWhatsAppWaiting_tenantId_createdAt_idx" ON "AssistantWhatsAppWaiting"("tenantId", "createdAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is what makes the grant safe.
ALTER TABLE "AssistantWhatsAppWaiting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantWhatsAppWaiting_tenant_isolation" ON "AssistantWhatsAppWaiting";
CREATE POLICY "AssistantWhatsAppWaiting_tenant_isolation" ON "AssistantWhatsAppWaiting"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantWhatsAppWaiting" FORCE ROW LEVEL SECURITY;
