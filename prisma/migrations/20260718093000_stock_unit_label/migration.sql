-- Optional organisational label on a stock unit (demo / showroom / consignment /
-- management hold …), configurable in settings and distinct from the lifecycle
-- `status`. Additive.
ALTER TABLE "StockUnit" ADD COLUMN IF NOT EXISTS "label" TEXT;

CREATE INDEX IF NOT EXISTS "StockUnit_label_idx" ON "StockUnit" ("label") WHERE "label" IS NOT NULL;
