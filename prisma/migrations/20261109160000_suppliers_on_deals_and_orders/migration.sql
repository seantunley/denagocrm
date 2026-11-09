-- Suppliers, part two (review of #1040, 2026-11-09). Additive only; re-runnable.
--  * Vendor: what it is (kind), company details, and the (tenantId, id) key every tenant table carries.
--  * Document → Vendor: a composite tenant FK, so a document can't name another workspace's supplier.
--  * DealVendor: the suppliers a deal declares, so its file asks for their papers before any arrive.
--  * PurchaseOrder.vendorId: the order's supplier as a record; existing orders backfilled by name.

ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "vatNumber" TEXT;
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "paymentReference" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Vendor_tenantId_id_key" ON "Vendor"("tenantId", "id");

-- Document → Vendor, within the document's workspace. Every row naming a supplier was written by this PR's code,
-- which already checks the workspace, so the constraint is valid from the start.
CREATE INDEX IF NOT EXISTS "Document_tenantId_vendorId_idx" ON "Document"("tenantId", "vendorId");
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_vendorId_fkey"
    FOREIGN KEY ("tenantId", "vendorId") REFERENCES "Vendor"("tenantId", "id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The suppliers on a deal. The deal is its lead, or the quote for a quote with no lead.
CREATE TABLE IF NOT EXISTS "DealVendor" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "leadId" TEXT,
  "quoteId" TEXT,
  "vendorId" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DealVendor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DealVendor_one_deal_check" CHECK (("leadId" IS NULL) <> ("quoteId" IS NULL))
);
CREATE INDEX IF NOT EXISTS "DealVendor_tenantId_leadId_idx" ON "DealVendor"("tenantId", "leadId");
CREATE INDEX IF NOT EXISTS "DealVendor_tenantId_quoteId_idx" ON "DealVendor"("tenantId", "quoteId");
CREATE INDEX IF NOT EXISTS "DealVendor_tenantId_vendorId_idx" ON "DealVendor"("tenantId", "vendorId");
-- A supplier once per deal (Prisma can't express a partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS "DealVendor_lead_vendor_key" ON "DealVendor"("tenantId", "leadId", "vendorId") WHERE "leadId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "DealVendor_quote_vendor_key" ON "DealVendor"("tenantId", "quoteId", "vendorId") WHERE "quoteId" IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE "DealVendor" ADD CONSTRAINT "DealVendor_tenantId_vendorId_fkey"
    FOREIGN KEY ("tenantId", "vendorId") REFERENCES "Vendor"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DealVendor" ADD CONSTRAINT "DealVendor_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DealVendor" ADD CONSTRAINT "DealVendor_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "DealVendor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DealVendor_tenant_isolation" ON "DealVendor";
CREATE POLICY "DealVendor_tenant_isolation" ON "DealVendor"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "DealVendor" FORCE ROW LEVEL SECURITY;

-- Purchase orders name their supplier as a record.
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "vendorId" TEXT;
CREATE INDEX IF NOT EXISTS "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_tenantId_vendorId_idx" ON "PurchaseOrder"("tenantId", "vendorId");
DO $$ BEGIN
  ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_vendorId_fkey"
    FOREIGN KEY ("tenantId", "vendorId") REFERENCES "Vendor"("tenantId", "id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- BACKFILL: one supplier per workspace per distinct name already typed on its orders ("Denago" on most), and
-- each order linked to it. Vendor and PurchaseOrder FORCE row-level security, so without the escape a migrating
-- role lacking BYPASSRLS would insert and update nothing and still be recorded as applied. The id is derived
-- from the workspace and name, so a re-run finds the same row instead of adding a second.
SET app.bypass_rls = 'on';
INSERT INTO "Vendor" ("id", "tenantId", "name", "kind", "createdAt", "updatedAt")
SELECT 'vnd_' || md5(po."tenantId" || ':' || lower(btrim(po."supplier"))), po."tenantId", min(btrim(po."supplier")), 'oem', now(), now()
FROM "PurchaseOrder" po
WHERE po."tenantId" IS NOT NULL AND btrim(coalesce(po."supplier", '')) <> ''
GROUP BY po."tenantId", lower(btrim(po."supplier"))
ON CONFLICT ("id") DO NOTHING;
UPDATE "PurchaseOrder" po
SET "vendorId" = 'vnd_' || md5(po."tenantId" || ':' || lower(btrim(po."supplier")))
WHERE po."vendorId" IS NULL AND po."tenantId" IS NOT NULL AND btrim(coalesce(po."supplier", '')) <> ''
  AND EXISTS (SELECT 1 FROM "Vendor" v WHERE v."id" = 'vnd_' || md5(po."tenantId" || ':' || lower(btrim(po."supplier"))));
RESET app.bypass_rls;
