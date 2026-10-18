-- Proactive DAX (Sean, 2026-10-18): one alert to one person about one customer
-- event — a quote opened, revisited or signed, a message with no answer, a
-- booking. Unique per person, kind and record, so the same event never alerts
-- twice; held alerts (quiet hours, the day's ceiling) wait here until due.
-- Additive only; re-runnable.

CREATE TABLE IF NOT EXISTS "AssistantProactiveAlert" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "recordKey" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "deliverAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "turnId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantProactiveAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantProactiveAlert_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantProactiveAlert_tenantId_userId_kind_recordKey_key"
  ON "AssistantProactiveAlert"("tenantId", "userId", "kind", "recordKey");
CREATE INDEX IF NOT EXISTS "AssistantProactiveAlert_deliveredAt_deliverAt_idx" ON "AssistantProactiveAlert"("deliveredAt", "deliverAt");
CREATE INDEX IF NOT EXISTS "AssistantProactiveAlert_tenantId_userId_createdAt_idx" ON "AssistantProactiveAlert"("tenantId", "userId", "createdAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. One workspace never reads or writes another's.
ALTER TABLE "AssistantProactiveAlert" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AssistantProactiveAlert_tenant_isolation" ON "AssistantProactiveAlert";
CREATE POLICY "AssistantProactiveAlert_tenant_isolation" ON "AssistantProactiveAlert"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AssistantProactiveAlert" FORCE ROW LEVEL SECURITY;
