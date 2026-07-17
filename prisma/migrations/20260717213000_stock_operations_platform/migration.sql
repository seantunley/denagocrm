-- Stock operations platform: integrity, reservations, purchasing, PDI, valuation and intelligence.
-- Additive by design so existing stock and purchase-order records remain valid.

CREATE TABLE IF NOT EXISTS "StockLocation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'showroom',
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StockLocation_name_key" ON "StockLocation"("name");
CREATE INDEX IF NOT EXISTS "StockLocation_active_idx" ON "StockLocation"("active", "name");

INSERT INTO "StockLocation" ("id", "name", "type", "isDefault")
VALUES ('stock-location-showroom', 'Main showroom', 'showroom', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "StockLocation" ("id", "name", "type", "isDefault")
VALUES ('stock-location-yard', 'Receiving yard', 'yard', false)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'ZAR';
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "shippedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "supplierInvoiceRef" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "freightCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "dutiesCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "otherCostsCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "color" TEXT,
    "orderedQty" INTEGER NOT NULL DEFAULT 1,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_po_idx" ON "PurchaseOrderLine"("purchaseOrderId", "sortOrder");
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_product_idx" ON "PurchaseOrderLine"("productId");

DO $$ BEGIN
  ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_po_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_product_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "notes" TEXT,
    "freightCents" INTEGER NOT NULL DEFAULT 0,
    "dutiesCents" INTEGER NOT NULL DEFAULT 0,
    "otherCostsCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "serialsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GoodsReceipt_po_idx" ON "GoodsReceipt"("purchaseOrderId", "receivedAt");
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_receipt_idx" ON "GoodsReceiptLine"("receiptId");
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_po_line_idx" ON "GoodsReceiptLine"("purchaseOrderLineId");

DO $$ BEGIN
  ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_po_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receipt_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_po_line_fkey"
    FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "stockNumber" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "condition" TEXT NOT NULL DEFAULT 'new';
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "manufacturingYear" INTEGER;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "batteryType" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "batterySerial" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "chargerSerial" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "keyCount" INTEGER;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "odometerKm" INTEGER;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "operatingHours" INTEGER;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "pdiStatus" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "pdiChecklist" JSONB;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "pdiCompletedAt" TIMESTAMP(3);
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "pdiCompletedById" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "warrantyStartedAt" TIMESTAMP(3);
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "warrantyExpiresAt" TIMESTAMP(3);
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "landedCostCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "salePriceCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "soldContactId" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "holdReason" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "consignmentOwner" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "purchaseOrderLineId" TEXT;
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "StockUnit"
SET "stockNumber" = 'STK-' || UPPER(SUBSTRING(MD5("id") FROM 1 FOR 8))
WHERE "stockNumber" IS NULL;

UPDATE "StockUnit"
SET "locationId" = 'stock-location-showroom'
WHERE "locationId" IS NULL AND "status" <> 'incoming';

UPDATE "StockUnit"
SET "landedCostCents" = "costCents"
WHERE "landedCostCents" = 0 AND "costCents" > 0;

CREATE UNIQUE INDEX IF NOT EXISTS "StockUnit_stockNumber_key" ON "StockUnit"("stockNumber") WHERE "stockNumber" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "StockUnit_serial_active_key" ON "StockUnit"(UPPER("serial")) WHERE "serial" IS NOT NULL AND "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "StockUnit_location_idx" ON "StockUnit"("locationId", "status") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "StockUnit_age_idx" ON "StockUnit"("arrivedAt", "status") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "StockUnit_po_line_idx" ON "StockUnit"("purchaseOrderLineId");
CREATE INDEX IF NOT EXISTS "StockUnit_quote_idx" ON "StockUnit"("soldQuoteId", "status") WHERE "deletedAt" IS NULL;

DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_location_fkey"
    FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_po_line_fkey"
    FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_sold_contact_fkey"
    FOREIGN KEY ("soldContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockReservation" (
    "id" TEXT NOT NULL,
    "stockUnitId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "quoteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "depositRequiredCents" INTEGER NOT NULL DEFAULT 0,
    "depositReceivedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "reservedById" TEXT,
    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StockReservation_active_unit_key"
ON "StockReservation"("stockUnitId") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "StockReservation_expiry_idx" ON "StockReservation"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "StockReservation_lead_idx" ON "StockReservation"("leadId", "status");
CREATE INDEX IF NOT EXISTS "StockReservation_quote_idx" ON "StockReservation"("quoteId", "status");

DO $$ BEGIN
  ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_unit_fkey"
    FOREIGN KEY ("stockUnitId") REFERENCES "StockUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_lead_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quote_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockMovement" (
    "id" TEXT NOT NULL,
    "stockUnitId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "costBeforeCents" INTEGER,
    "costAfterCents" INTEGER,
    "leadId" TEXT,
    "quoteId" TEXT,
    "purchaseOrderId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "performedById" TEXT,
    "performedByName" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StockMovement_unit_idx" ON "StockMovement"("stockUnitId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "StockMovement_event_idx" ON "StockMovement"("eventType", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "StockMovement_quote_idx" ON "StockMovement"("quoteId", "occurredAt" DESC);

DO $$ BEGIN
  ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_unit_fkey"
    FOREIGN KEY ("stockUnitId") REFERENCES "StockUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockAttachment" (
    "id" TEXT NOT NULL,
    "stockUnitId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'photo',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StockAttachment_unit_idx" ON "StockAttachment"("stockUnitId", "createdAt" DESC);
DO $$ BEGIN
  ALTER TABLE "StockAttachment" ADD CONSTRAINT "StockAttachment_unit_fkey"
    FOREIGN KEY ("stockUnitId") REFERENCES "StockUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed an import event for legacy active units so every record has a ledger origin.
INSERT INTO "StockMovement" (
    "id", "stockUnitId", "eventType", "fromStatus", "toStatus", "costAfterCents", "performedByName", "reason"
)
SELECT
    'migration-' || "id",
    "id",
    'legacy_import',
    NULL,
    "status",
    COALESCE(NULLIF("landedCostCents", 0), "costCents"),
    'System migration',
    'Existing stock imported into the operations ledger'
FROM "StockUnit"
WHERE "deletedAt" IS NULL
ON CONFLICT ("id") DO NOTHING;
