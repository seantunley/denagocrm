-- Warranty in parts (Sean, 2026-11-21): "5 Years on the Battery, 2 years on the cart and lifetime on the chassis. But the
-- warranty details need to be captured per vehicle." A product carries its terms; each vehicle gets its own copy at
-- delivery, dated from the delivery day (src/lib/warrantyParts.ts). Additive, nullable, re-runnable; no backfill — a
-- vehicle without parts keeps showing its single warrantyMonths exactly as before.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "warrantyTerms" JSONB;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "warrantyParts" JSONB;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "warrantyStartsAt" TIMESTAMP(3);
