-- DAX watches ("tell me when Anna opens her quote"): conditions the assistant
-- cron checks with plain code and tells only the person who set them. Plus the
-- thumbs up/down on an answer. Additive only.

ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "feedback" TEXT;
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "feedbackReason" TEXT;
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "feedbackAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AssistantWatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "leadId" TEXT,
  "quoteId" TEXT,
  "product" TEXT,
  "thresholdHours" INTEGER,
  "thresholdDays" INTEGER,
  "label" TEXT NOT NULL,
  "fired" JSONB,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastCheckedAt" TIMESTAMP(3),
  "lastFiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantWatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantWatch_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantWatch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantWatch_tenantId_userId_idx" ON "AssistantWatch"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "AssistantWatch_active_idx" ON "AssistantWatch"("active");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. Without it the table fails closed in production.
ALTER TABLE "AssistantWatch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantWatch_tenant_isolation" ON "AssistantWatch";
CREATE POLICY "AssistantWatch_tenant_isolation" ON "AssistantWatch"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantWatch" FORCE ROW LEVEL SECURITY;
