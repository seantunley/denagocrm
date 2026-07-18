-- Link each incoming unit to its purchase-order line so receiving can be genuinely
-- partial (per line / per serial) and backorders are traceable. Additive.
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "purchaseOrderLineId" TEXT;

CREATE INDEX IF NOT EXISTS "StockUnit_po_line_idx" ON "StockUnit" ("purchaseOrderLineId");

DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_purchaseOrderLineId_fkey"
    FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
