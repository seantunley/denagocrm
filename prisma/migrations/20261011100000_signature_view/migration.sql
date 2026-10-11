-- Signing engagement: one row per sitting with a signing page — when it was
-- open, how long the tab was in view, the furthest page reached. Not part of
-- the evidence hash chain, and it holds no IP address or browser string.
-- Additive only.

CREATE TABLE IF NOT EXISTS "SignatureView" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seconds" INTEGER NOT NULL DEFAULT 0,
  "maxPage" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "SignatureView_pkey" PRIMARY KEY ("id"),
  -- The row belongs to a workspace, and goes when the workspace, the request
  -- or the recipient goes.
  CONSTRAINT "SignatureView_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SignatureView_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SignatureView_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "SignatureRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SignatureView_tenantId_requestId_idx" ON "SignatureView"("tenantId", "requestId");
CREATE INDEX IF NOT EXISTS "SignatureView_recipientId_startedAt_idx" ON "SignatureView"("recipientId", "startedAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. One workspace never reads or writes another's.
ALTER TABLE "SignatureView" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureView_tenant_isolation" ON "SignatureView";
CREATE POLICY "SignatureView_tenant_isolation" ON "SignatureView"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureView" FORCE ROW LEVEL SECURITY;
