-- Ask the CRM, from Hermes Agent: questions DAX answers on a schedule, and a
-- staff member's own WhatsApp number linked (by proof of possession) so they
-- can ask DAX from their phone. Additive only.

-- Where a turn came from (chat | schedule | whatsapp) and, for a scheduled
-- answer, when the person saw it (the bubble's unread dot).
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "scheduleId" TEXT;
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "seenAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AssistantSchedule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "cadence" TEXT NOT NULL,
  "weekday" INTEGER,
  "timeOfDay" TEXT NOT NULL,
  "onDate" TEXT,
  "nextRunAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantSchedule_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantSchedule_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantSchedule_tenantId_userId_idx" ON "AssistantSchedule"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "AssistantSchedule_active_nextRunAt_idx" ON "AssistantSchedule"("active", "nextRunAt");

CREATE TABLE IF NOT EXISTS "AssistantPhoneLink" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "waId" TEXT,
  "codeHash" TEXT,
  "codeExpiresAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantPhoneLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantPhoneLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantPhoneLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantPhoneLink_tenantId_userId_key" ON "AssistantPhoneLink"("tenantId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantPhoneLink_tenantId_waId_key" ON "AssistantPhoneLink"("tenantId", "waId");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe.
ALTER TABLE "AssistantSchedule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantSchedule_tenant_isolation" ON "AssistantSchedule";
CREATE POLICY "AssistantSchedule_tenant_isolation" ON "AssistantSchedule"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantSchedule" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AssistantPhoneLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantPhoneLink_tenant_isolation" ON "AssistantPhoneLink";
CREATE POLICY "AssistantPhoneLink_tenant_isolation" ON "AssistantPhoneLink"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantPhoneLink" FORCE ROW LEVEL SECURITY;
