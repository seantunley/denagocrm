-- A deal financed through an outside finance house (2026-11-16). One per lead. Additive; re-runnable.
CREATE TABLE IF NOT EXISTS "DealFinance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "reference" TEXT,
  "status" TEXT NOT NULL DEFAULT 'docs_outstanding',
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealFinance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DealFinance_status_check" CHECK ("status" IN ('docs_outstanding', 'submitted', 'approved', 'declined', 'paid_out', 'withdrawn'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "DealFinance_tenantId_id_key" ON "DealFinance"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "DealFinance_tenantId_leadId_key" ON "DealFinance"("tenantId", "leadId");
CREATE INDEX IF NOT EXISTS "DealFinance_tenantId_vendorId_idx" ON "DealFinance"("tenantId", "vendorId");
CREATE INDEX IF NOT EXISTS "DealFinance_tenantId_status_statusAt_idx" ON "DealFinance"("tenantId", "status", "statusAt");

-- Within one workspace only: the lead and the finance house. A finance house with deals on it can't be hard-deleted
-- (suppliers are soft-deleted anyway).
DO $$ BEGIN
  ALTER TABLE "DealFinance" ADD CONSTRAINT "DealFinance_tenantId_vendorId_fkey"
    FOREIGN KEY ("tenantId", "vendorId") REFERENCES "Vendor"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DealFinance" ADD CONSTRAINT "DealFinance_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is what makes the grant safe.
ALTER TABLE "DealFinance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DealFinance_tenant_isolation" ON "DealFinance";
CREATE POLICY "DealFinance_tenant_isolation" ON "DealFinance"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "DealFinance" FORCE ROW LEVEL SECURITY;
