-- A delivery booked with a transport supplier, to a customer (quote) or to the warehouse (purchase order).
-- 2026-11-09. Additive; re-runnable.
CREATE TABLE IF NOT EXISTS "VendorDelivery" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "quoteId" TEXT,
  "purchaseOrderId" TEXT,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "fromAddress" TEXT NOT NULL,
  "toAddress" TEXT NOT NULL,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentTo" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VendorDelivery_pkey" PRIMARY KEY ("id"),
  -- Outbound to a customer OR inbound on a purchase order: exactly one.
  CONSTRAINT "VendorDelivery_one_target" CHECK (("quoteId" IS NULL) <> ("purchaseOrderId" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "VendorDelivery_tenantId_id_key" ON "VendorDelivery"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "VendorDelivery_tenantId_quoteId_idx" ON "VendorDelivery"("tenantId", "quoteId");
CREATE INDEX IF NOT EXISTS "VendorDelivery_tenantId_purchaseOrderId_idx" ON "VendorDelivery"("tenantId", "purchaseOrderId");
CREATE INDEX IF NOT EXISTS "VendorDelivery_tenantId_vendorId_idx" ON "VendorDelivery"("tenantId", "vendorId");

-- Within one workspace only: the supplier, the quote, the purchase order.
DO $$ BEGIN
  ALTER TABLE "VendorDelivery" ADD CONSTRAINT "VendorDelivery_tenantId_vendorId_fkey"
    FOREIGN KEY ("tenantId", "vendorId") REFERENCES "Vendor"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "VendorDelivery" ADD CONSTRAINT "VendorDelivery_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "VendorDelivery" ADD CONSTRAINT "VendorDelivery_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "VendorDelivery" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "VendorDelivery_tenant_isolation" ON "VendorDelivery";
CREATE POLICY "VendorDelivery_tenant_isolation" ON "VendorDelivery"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "VendorDelivery" FORCE ROW LEVEL SECURITY;
