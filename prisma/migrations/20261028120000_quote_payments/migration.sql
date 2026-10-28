-- Customer statements (2026-10-28): money received against an invoice AFTER the
-- deposit — part-payments, the final balance, a finance payout. The deposit
-- itself stays on "Quote"."depositPaidCents" (recorded on the deliveries board);
-- every other payment is a row here. A wrong entry is voided, never deleted, so
-- the statement's history never changes under a customer's feet.
-- Additive only; re-runnable.

CREATE TABLE IF NOT EXISTS "QuotePayment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "method" TEXT NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "createdById" TEXT,
  "createdByName" TEXT NOT NULL,
  "voidedAt" TIMESTAMP(3),
  "voidedByName" TEXT,
  "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuotePayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuotePayment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuotePayment_amountCents_check" CHECK ("amountCents" > 0)
);

CREATE INDEX IF NOT EXISTS "QuotePayment_tenantId_quoteId_receivedAt_idx" ON "QuotePayment"("tenantId", "quoteId", "receivedAt");

-- A payment belongs to a quote in the SAME workspace: the composite key makes a
-- cross-tenant quoteId impossible to store, not merely unlikely.
DO $$ BEGIN
  ALTER TABLE "QuotePayment" ADD CONSTRAINT "QuotePayment_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES (as every table
-- since the RLS cutover); the policy is what makes the grant safe.
ALTER TABLE "QuotePayment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "QuotePayment_tenant_isolation" ON "QuotePayment";
CREATE POLICY "QuotePayment_tenant_isolation" ON "QuotePayment"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "QuotePayment" FORCE ROW LEVEL SECURITY;
