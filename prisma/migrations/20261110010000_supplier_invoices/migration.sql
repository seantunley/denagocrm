-- What a supplier invoice says: read by AI, confirmed by a person (2026-11-09). Additive; re-runnable.
CREATE TABLE IF NOT EXISTS "SupplierInvoice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "invoiceNumber" TEXT,
  "invoiceDate" TIMESTAMP(3),
  "dueDate" TIMESTAMP(3),
  "totalCents" INTEGER,
  "currency" TEXT,
  "status" TEXT NOT NULL DEFAULT 'read',
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "confirmedById" TEXT,
  CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierInvoice_documentId_key" ON "SupplierInvoice"("documentId");
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierInvoice_tenantId_id_key" ON "SupplierInvoice"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "SupplierInvoice_tenantId_status_idx" ON "SupplierInvoice"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "SupplierInvoice_tenantId_dueDate_idx" ON "SupplierInvoice"("tenantId", "dueDate");
CREATE INDEX IF NOT EXISTS "SupplierInvoice_tenantId_documentId_idx" ON "SupplierInvoice"("tenantId", "documentId");

-- The invoice belongs to its document, in the same workspace; it goes when the document is purged.
DO $$ BEGIN
  ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_documentId_fkey"
    FOREIGN KEY ("tenantId", "documentId") REFERENCES "Document"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "SupplierInvoice" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SupplierInvoice_tenant_isolation" ON "SupplierInvoice";
CREATE POLICY "SupplierInvoice_tenant_isolation" ON "SupplierInvoice"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "SupplierInvoice" FORCE ROW LEVEL SECURITY;
