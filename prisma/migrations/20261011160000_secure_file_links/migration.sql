-- Secure links: a file sent to a customer as an expiring, recallable link
-- instead of an attachment. The link's value is stored only as a SHA-256 hash.
-- No IP address or browser string is kept about a download. Additive only.

CREATE TABLE IF NOT EXISTS "SecureFileLink" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "storedRef" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sentTo" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "communicationId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedById" TEXT,
  "firstOpenedAt" TIMESTAMP(3),
  "lastOpenedAt" TIMESTAMP(3),
  "openCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SecureFileLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecureFileLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SecureFileLink_token_key" ON "SecureFileLink"("token");
CREATE INDEX IF NOT EXISTS "SecureFileLink_tenantId_contactId_createdAt_idx" ON "SecureFileLink"("tenantId", "contactId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecureFileLink_tenantId_leadId_createdAt_idx" ON "SecureFileLink"("tenantId", "leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecureFileLink_communicationId_idx" ON "SecureFileLink"("communicationId");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. One workspace never reads or writes another's.
ALTER TABLE "SecureFileLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SecureFileLink_tenant_isolation" ON "SecureFileLink";
CREATE POLICY "SecureFileLink_tenant_isolation" ON "SecureFileLink"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SecureFileLink" FORCE ROW LEVEL SECURITY;
