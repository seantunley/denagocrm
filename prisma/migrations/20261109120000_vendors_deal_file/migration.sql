-- Deal file (2026-11-09): suppliers (Vendor) and the supplier a document is from. Additive only; re-runnable.
CREATE TABLE IF NOT EXISTS "Vendor" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Vendor_tenantId_name_idx" ON "Vendor"("tenantId", "name");

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "vendorId" TEXT;
CREATE INDEX IF NOT EXISTS "Document_vendorId_idx" ON "Document"("vendorId");
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Same isolation as every table since the RLS cutover; without the policy the table fails closed in production.
ALTER TABLE "Vendor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Vendor_tenant_isolation" ON "Vendor";
CREATE POLICY "Vendor_tenant_isolation" ON "Vendor"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "Vendor" FORCE ROW LEVEL SECURITY;
