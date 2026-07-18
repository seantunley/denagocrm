-- Stock platform phases 1-4: integrity, reservations, purchasing, fulfilment and intelligence.

ALTER TABLE "StockUnit"
  ADD COLUMN IF NOT EXISTS "stockNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "location" TEXT,
  ADD COLUMN IF NOT EXISTS "condition" TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS "batterySerial" TEXT,
  ADD COLUMN IF NOT EXISTS "chargerSerial" TEXT,
  ADD COLUMN IF NOT EXISTS "odometerKm" INTEGER,
  ADD COLUMN IF NOT EXISTS "landedCostCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "salePriceCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "pdiStatus" TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS "pdiCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "warrantyStartAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "warrantyEndAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Normalise + de-duplicate active serials BEFORE the unique index so this cannot
-- fail on legacy data quality. Blank serials become NULL; remaining serials are
-- trimmed/whitespace-stripped/upper-cased; the oldest active record keeps a
-- duplicated identifier while later duplicates are flagged in notes and cleared.
UPDATE "StockUnit" SET "serial" = NULL WHERE "serial" IS NOT NULL AND TRIM("serial") = '';
UPDATE "StockUnit"
SET "serial" = UPPER(REGEXP_REPLACE(TRIM("serial"), '\s+', '', 'g'))
WHERE "serial" IS NOT NULL;
WITH ranked AS (
  SELECT "id", "serial",
    ROW_NUMBER() OVER (
      PARTITION BY UPPER("serial")
      ORDER BY COALESCE("arrivedAt", "createdAt") ASC, "id" ASC
    ) AS duplicate_rank
  FROM "StockUnit"
  WHERE "serial" IS NOT NULL AND "deletedAt" IS NULL
), duplicates AS (
  SELECT "id", "serial" FROM ranked WHERE duplicate_rank > 1
)
UPDATE "StockUnit" AS unit
SET
  "notes" = CONCAT_WS(
    E'\n',
    NULLIF(unit."notes", ''),
    'Migration warning: duplicate active serial ' || duplicates."serial" || ' was cleared — verify the physical identifier.'
  ),
  "serial" = NULL
FROM duplicates
WHERE unit."id" = duplicates."id";

CREATE UNIQUE INDEX IF NOT EXISTS "StockUnit_active_serial_key"
  ON "StockUnit" (UPPER("serial"))
  WHERE "serial" IS NOT NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "StockUnit_stockNumber_key"
  ON "StockUnit" ("stockNumber")
  WHERE "stockNumber" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "StockUnit_location_status_idx" ON "StockUnit" ("location", "status");
CREATE INDEX IF NOT EXISTS "StockUnit_arrivedAt_idx" ON "StockUnit" ("arrivedAt");

CREATE TABLE IF NOT EXISTS "StockReservation" (
  "id" TEXT NOT NULL,
  "stockUnitId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "quoteId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "depositRequiredCents" INTEGER NOT NULL DEFAULT 0,
  "depositReceivedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  "reservedById" TEXT NOT NULL,
  CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockReservation_stockUnitId_fkey" FOREIGN KEY ("stockUnitId") REFERENCES "StockUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StockReservation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StockReservation_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "StockReservation_reservedById_fkey" FOREIGN KEY ("reservedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "StockReservation_active_unit_key"
  ON "StockReservation" ("stockUnitId") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "StockReservation_expiry_idx" ON "StockReservation" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "StockReservation_lead_idx" ON "StockReservation" ("leadId", "status");

CREATE TABLE IF NOT EXISTS "StockEvent" (
  "id" TEXT NOT NULL,
  "stockUnitId" TEXT,
  "purchaseOrderId" TEXT,
  "eventType" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "leadId" TEXT,
  "quoteId" TEXT,
  "reason" TEXT,
  "detail" TEXT,
  "costBeforeCents" INTEGER,
  "costAfterCents" INTEGER,
  "performedById" TEXT NOT NULL,
  "performedByName" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockEvent_stockUnitId_fkey" FOREIGN KEY ("stockUnitId") REFERENCES "StockUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "StockEvent_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "StockEvent_unit_time_idx" ON "StockEvent" ("stockUnitId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "StockEvent_po_time_idx" ON "StockEvent" ("purchaseOrderId", "occurredAt" DESC);

CREATE TABLE IF NOT EXISTS "PurchaseOrderLine" (
  "id" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "color" TEXT,
  "orderedQty" INTEGER NOT NULL,
  "receivedQty" INTEGER NOT NULL DEFAULT 0,
  "unitCostCents" INTEGER NOT NULL DEFAULT 0,
  "freightCents" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PurchaseOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_po_idx" ON "PurchaseOrderLine" ("purchaseOrderId");

CREATE TABLE IF NOT EXISTS "GoodsReceipt" (
  "id" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "reference" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedById" TEXT NOT NULL,
  "notes" TEXT,
  CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GoodsReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "GoodsReceipt_po_idx" ON "GoodsReceipt" ("purchaseOrderId", "receivedAt" DESC);

CREATE TABLE IF NOT EXISTS "GoodsReceiptLine" (
  "id" TEXT NOT NULL,
  "goodsReceiptId" TEXT NOT NULL,
  "purchaseOrderLineId" TEXT,
  "stockUnitId" TEXT NOT NULL,
  "accepted" BOOLEAN NOT NULL DEFAULT true,
  "conditionNote" TEXT,
  CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "GoodsReceiptLine_stockUnitId_fkey" FOREIGN KEY ("stockUnitId") REFERENCES "StockUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_receipt_idx" ON "GoodsReceiptLine" ("goodsReceiptId");

-- Bring existing records into the expanded workflow without changing their meaning.
UPDATE "StockUnit" SET "landedCostCents" = "costCents" WHERE "landedCostCents" = 0 AND "costCents" > 0;
UPDATE "PurchaseOrder" po
SET "status" = 'partially_received'
WHERE po."status" = 'ordered'
  AND EXISTS (SELECT 1 FROM "StockUnit" su WHERE su."purchaseOrderId" = po."id" AND su."status" <> 'incoming' AND su."deletedAt" IS NULL)
  AND EXISTS (SELECT 1 FROM "StockUnit" su WHERE su."purchaseOrderId" = po."id" AND su."status" = 'incoming' AND su."deletedAt" IS NULL);

-- Backfill authoritative reservations for units already reserved under the legacy
-- cache. StockReservation is the source of truth, so without this a legacy reserved
-- unit would have no reservation row: deposits, auto-expiry and reservation reporting
-- would all miss it. Legacy rows have no original reserver or expiry, so we use the
-- oldest user as a documented migration actor and leave expiresAt NULL (no auto-expiry).
INSERT INTO "StockReservation" (
  "id", "stockUnitId", "leadId", "status", "reservedAt", "expiresAt", "reservedById"
)
SELECT
  'legacy-res-' || su."id", su."id", su."reservedForLeadId", 'active',
  COALESCE(su."arrivedAt", su."createdAt"), NULL,
  (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
FROM "StockUnit" su
WHERE su."reservedForLeadId" IS NOT NULL
  AND su."status" = 'reserved'
  AND su."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "StockReservation" r
    WHERE r."stockUnitId" = su."id" AND r."status" = 'active'
  )
ON CONFLICT DO NOTHING;
