-- Email signature details per person (the Email signatures pack, 2026-11-20: item 1 of
-- email-signature-improvements.md). Additive: nullable text columns and a false-by-default photo opt-in, so every
-- existing signature renders exactly as before until someone fills one in.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureQualifications" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureDirectLine" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureWhatsapp" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureBookingUrl" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureHours" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signaturePhoto" BOOLEAN NOT NULL DEFAULT false;
