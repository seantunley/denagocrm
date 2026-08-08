-- Fleets as business records, and contacts that belong to a fleet.
--
-- ADDITIVE AND IDEMPOTENT ONLY. Every statement is ADD COLUMN IF NOT EXISTS or
-- CREATE INDEX IF NOT EXISTS; nothing existing is dropped, renamed, retyped or
-- made NOT NULL, and no table is created (so no new RLS policy is required —
-- Contact and Fleet already have theirs).
--
-- EXPAND-SAFE: every column added here is nullable, so the build currently
-- deployed simply never selects them and keeps running unchanged while this
-- migration is applied. No expand/contract dance, no backfill, no downtime.
--
-- 1. Contact.fleetId — fleet MEMBERSHIP (the many side). This is what the new
--    "Fleet" option on the customer-type selector writes. It is NOT a
--    replacement for Fleet.contactId, which stays exactly as it is and still
--    names the single primary contact / fleet manager.
-- 2. Contact.vatNumber / Fleet.vatNumber — a VAT number is captured against
--    whichever entity a quote would be addressed to, so both can hold one. Same
--    column name on both models: one name for one concept.
-- 3. The rest of the Fleet columns make a fleet a complete billable business
--    record (registration, VAT, billing contact, address).

-- Contact ---------------------------------------------------------------------
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "fleetId" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "vatNumber" TEXT;

-- Every fleet page lists its members by this column; without the index that is a
-- sequential scan of the whole contact table per fleet.
CREATE INDEX IF NOT EXISTS "Contact_fleetId_idx" ON "Contact"("fleetId");

-- Fleet -----------------------------------------------------------------------
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "vatNumber" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "billingEmail" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "billingPhone" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "suburb" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "province" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;
