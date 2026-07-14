-- Persist the selected catalogue product and the customer's colour preference
-- on each quote line so revisions and generated documents retain it.
ALTER TABLE "QuoteItem"
  ADD COLUMN "productId" TEXT,
  ADD COLUMN "colorPreference" TEXT;

CREATE INDEX "QuoteItem_productId_idx" ON "QuoteItem"("productId");

ALTER TABLE "QuoteItem"
  ADD CONSTRAINT "QuoteItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
