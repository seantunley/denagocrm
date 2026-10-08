-- Ask the CRM: conversation history (30 days, private to the asker) and what
-- the assistant learns (workspace memory, personal profile, playbooks). Additive only.

CREATE TABLE IF NOT EXISTS "AssistantTurn" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "tools" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantTurn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantTurn_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantTurn_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantTurn_tenantId_userId_createdAt_idx" ON "AssistantTurn"("tenantId", "userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantTurn_createdAt_idx" ON "AssistantTurn"("createdAt");

CREATE TABLE IF NOT EXISTS "AssistantNote" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "userId" TEXT,
  "name" TEXT,
  "description" TEXT,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unreviewed',
  "createdById" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantNote_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantNote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantNote_tenantId_kind_idx" ON "AssistantNote"("tenantId", "kind");
CREATE INDEX IF NOT EXISTS "AssistantNote_tenantId_userId_idx" ON "AssistantNote"("tenantId", "userId");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe.
ALTER TABLE "AssistantTurn" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantTurn_tenant_isolation" ON "AssistantTurn";
CREATE POLICY "AssistantTurn_tenant_isolation" ON "AssistantTurn"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantTurn" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AssistantNote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantNote_tenant_isolation" ON "AssistantNote";
CREATE POLICY "AssistantNote_tenant_isolation" ON "AssistantNote"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantNote" FORCE ROW LEVEL SECURITY;
