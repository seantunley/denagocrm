-- A photo or screenshot sent to DAX, kept for ONE HOUR (Sean, 2026-11-02): DAX asks
-- "pin the screenshot, or add its text?", and the answer arrives without the picture.
-- Read back only for the reply that directly follows; deleted after an hour.
-- Additive only; re-runnable.

CREATE TABLE IF NOT EXISTS "AssistantImage" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "jpeg" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantImage_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantImage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantImage_turnId_key" ON "AssistantImage"("turnId");
-- The hourly delete.
CREATE INDEX IF NOT EXISTS "AssistantImage_createdAt_idx" ON "AssistantImage"("createdAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES (as every table
-- since the RLS cutover); the policy is what makes the grant safe. Without it
-- the table fails closed in production. One workspace never reads another's images.
ALTER TABLE "AssistantImage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantImage_tenant_isolation" ON "AssistantImage";
CREATE POLICY "AssistantImage_tenant_isolation" ON "AssistantImage"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantImage" FORCE ROW LEVEL SECURITY;
