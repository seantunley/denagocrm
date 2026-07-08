-- Cart stock/inventory + supplier purchase orders.
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "reference" TEXT,
    "supplier" TEXT NOT NULL DEFAULT 'Denago',
    "status" TEXT NOT NULL DEFAULT 'ordered',
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockUnit" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "color" TEXT,
    "serial" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incoming',
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "purchaseOrderId" TEXT,
    "reservedForLeadId" TEXT,
    "soldQuoteId" TEXT,
    CONSTRAINT "StockUnit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockUnit_status_idx" ON "StockUnit"("status");
CREATE INDEX "StockUnit_productId_idx" ON "StockUnit"("productId");

ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_reservedForLeadId_fkey" FOREIGN KEY ("reservedForLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_soldQuoteId_fkey" FOREIGN KEY ("soldQuoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
