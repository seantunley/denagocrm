-- A photo, screenshot or file sent to DAX, HELD — never filed on its own (Sean, 2026-11-02).
-- Handed back for the reply that directly follows ("pin it to Clive"), and read by Confirm
-- when a card files it on a record. Deleted by the assistant cron after a day.
-- Additive only; re-runnable.

CREATE TABLE IF NOT EXISTS "AssistantUpload" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "turnId" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantUpload_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantUpload_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantUpload_turnId_key" ON "AssistantUpload"("turnId");
-- The daily delete.
CREATE INDEX IF NOT EXISTS "AssistantUpload_createdAt_idx" ON "AssistantUpload"("createdAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES (as every table
-- since the RLS cutover); the policy is what makes the grant safe. Without it
-- the table fails closed in production. One workspace never reads another's uploads.
ALTER TABLE "AssistantUpload" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantUpload_tenant_isolation" ON "AssistantUpload";
CREATE POLICY "AssistantUpload_tenant_isolation" ON "AssistantUpload"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantUpload" FORCE ROW LEVEL SECURITY;
