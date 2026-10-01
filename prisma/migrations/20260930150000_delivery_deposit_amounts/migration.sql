-- Deposits record HOW MUCH was received, not only that something was.
--
-- The Deliveries board's "Deposit paid" and the stock unit's "Record deposit"
-- both stored a timestamp (and a proof-of-payment file / a reference) but no
-- amount, so nobody could see from the CRM what the customer had actually paid.
-- Money is stored as integer cents, like every other amount in this schema
-- (costCents, depositRequiredCents, salePriceCents).
--
-- Additive and nullable: a deposit recorded before this ships keeps a NULL
-- amount, which the UI shows as "amount not recorded" rather than R0.
-- Date-stamped so it sorts after 20260930120000_product_showcase_colour_images.
--
-- No RLS change: Quote and StockReservation already carry their tenant policies
-- (rows, not columns), and crm_app's grants are table-level, so the new columns
-- are covered as they are.

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "depositPaidCents" INTEGER;
ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "depositReceivedCents" INTEGER;
