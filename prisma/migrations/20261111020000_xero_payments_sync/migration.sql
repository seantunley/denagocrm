-- Additive and reentrant (the migration runner has no transaction).
-- Sean, 2026-11-11: invoices are made in the CRM and pushed to Xero; payments are
-- recorded in Xero and brought back. Each payment brought back remembers its Xero
-- PaymentID, so a Refresh never brings the same one twice.
ALTER TABLE "QuotePayment" ADD COLUMN IF NOT EXISTS "xeroPaymentId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "QuotePayment_tenantId_xeroPaymentId_key" ON "QuotePayment"("tenantId", "xeroPaymentId");
-- The Xero payment that became the invoice's deposit, and what Xero says has been paid.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroDepositPaymentId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroAmountPaidCents" INTEGER;
