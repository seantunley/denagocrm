-- A business customer's company / CK registration number (a fleet's is on "Fleet").
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;
