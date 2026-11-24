-- My Work: snooze and dismiss (brief §6/§7; Sean, 2026-11-24: "second PR"). One row per person per item on their
-- own list. Additive: a new table, empty until someone snoozes or dismisses; nothing reads it but My Work.
CREATE TABLE IF NOT EXISTS "WorkDisposition" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "until" TIMESTAMP(3) NOT NULL,
  "fingerprint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkDisposition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkDisposition_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkDisposition_tenantId_userId_itemKey_key" ON "WorkDisposition"("tenantId", "userId", "itemKey");
CREATE INDEX IF NOT EXISTS "WorkDisposition_tenantId_userId_until_idx" ON "WorkDisposition"("tenantId", "userId", "until");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is what makes the grant safe. One workspace
-- never reads or writes another's (the same policy as the other workspace tables).
ALTER TABLE "WorkDisposition" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WorkDisposition_tenant_isolation" ON "WorkDisposition";
CREATE POLICY "WorkDisposition_tenant_isolation" ON "WorkDisposition"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "WorkDisposition" FORCE ROW LEVEL SECURITY;
