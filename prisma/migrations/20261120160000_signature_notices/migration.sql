-- Dated lines on email signatures (Sean, 2026-11-20: "On leave until 5 January, contact Thandi", or holiday trading
-- hours, "which appear and disappear on schedule"). Additive: a new table, empty until someone adds a line.
CREATE TABLE IF NOT EXISTS "SignatureNotice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT,
  "text" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignatureNotice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureNotice_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SignatureNotice_tenantId_endsAt_idx" ON "SignatureNotice"("tenantId", "endsAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is what makes the grant safe. One workspace
-- never reads or writes another's (the same policy as the other signature tables).
ALTER TABLE "SignatureNotice" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureNotice_tenant_isolation" ON "SignatureNotice";
CREATE POLICY "SignatureNotice_tenant_isolation" ON "SignatureNotice"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureNotice" FORCE ROW LEVEL SECURITY;
