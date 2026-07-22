-- Multi-tenancy Phase B (stock cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "StockEvent" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PurchaseOrderLine" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "GoodsReceipt" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "GoodsReceiptLine" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ProductColor" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PartReservation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Product_tenantId_idx" ON "Product"("tenantId");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_tenantId_idx" ON "PurchaseOrder"("tenantId");
CREATE INDEX IF NOT EXISTS "StockUnit_tenantId_idx" ON "StockUnit"("tenantId");
CREATE INDEX IF NOT EXISTS "StockReservation_tenantId_idx" ON "StockReservation"("tenantId");
CREATE INDEX IF NOT EXISTS "StockEvent_tenantId_idx" ON "StockEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_tenantId_idx" ON "PurchaseOrderLine"("tenantId");
CREATE INDEX IF NOT EXISTS "GoodsReceipt_tenantId_idx" ON "GoodsReceipt"("tenantId");
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_tenantId_idx" ON "GoodsReceiptLine"("tenantId");
CREATE INDEX IF NOT EXISTS "ProductColor_tenantId_idx" ON "ProductColor"("tenantId");
CREATE INDEX IF NOT EXISTS "Part_tenantId_idx" ON "Part"("tenantId");
CREATE INDEX IF NOT EXISTS "PartReservation_tenantId_idx" ON "PartReservation"("tenantId");

UPDATE "Product" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PurchaseOrder" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "StockUnit" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "StockReservation" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "StockEvent" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PurchaseOrderLine" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "GoodsReceipt" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "GoodsReceiptLine" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "ProductColor" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Part" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PartReservation" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
