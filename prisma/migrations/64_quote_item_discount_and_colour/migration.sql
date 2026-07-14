-- Persist the selected catalogue product, the customer's colour preference, and
-- a per-line percentage discount on each quote line so revisions and generated
-- documents retain them. Idempotent: production already carries "productId" from
-- an earlier deploy, so every change guards against re-application.
ALTER TABLE "QuoteItem"
  ADD COLUMN IF NOT EXISTS "productId" TEXT,
  ADD COLUMN IF NOT EXISTS "colorPreference" TEXT,
  ADD COLUMN IF NOT EXISTS "discountPct" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "QuoteItem_productId_idx" ON "QuoteItem"("productId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'QuoteItem_productId_fkey'
  ) THEN
    ALTER TABLE "QuoteItem"
      ADD CONSTRAINT "QuoteItem_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
