-- Xero (Sean, 2026-11-10): "send the quote to Xero, then retrieve the invoice number from Xero and store it on
-- the record here. Our invoice numbers will be different from Xero." The CRM's own invoiceNumber is untouched;
-- these record the invoice Xero made for the quote.
-- Additive; re-runnable. The Quote table already has RLS and its grants.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroInvoiceId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroInvoiceNumber" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroStatus" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroTotalCents" INTEGER;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroSentAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroSentByName" TEXT;
