-- DAX batch 2: every chat question is a run the browser can reconnect to, so a
-- dropped connection re-reads the same run instead of asking twice. Holds the
-- answer so far, the finished result and per-phase timings. Additive only.

CREATE TABLE IF NOT EXISTS "AssistantRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'accepted',
  "statusText" TEXT,
  "partial" TEXT,
  "result" JSONB,
  "timings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "AssistantRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantRun_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Workspace first: one person's run key in workspace A is never their run in B.
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantRun_tenantId_userId_clientKey_key" ON "AssistantRun"("tenantId", "userId", "clientKey");
CREATE INDEX IF NOT EXISTS "AssistantRun_tenantId_userId_createdAt_idx" ON "AssistantRun"("tenantId", "userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantRun_createdAt_idx" ON "AssistantRun"("createdAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe.
ALTER TABLE "AssistantRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantRun_tenant_isolation" ON "AssistantRun";
CREATE POLICY "AssistantRun_tenant_isolation" ON "AssistantRun"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantRun" FORCE ROW LEVEL SECURITY;
