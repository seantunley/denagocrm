-- Xero (Sean, 2026-11-10): "send the quote to Xero, then retrieve the invoice number from Xero and store it on
-- the record here. Our invoice numbers will be different from Xero." The CRM's own invoiceNumber is untouched;
-- the Quote columns record the invoice Xero made for the quote, and Contact/Fleet keep the customer's Xero
-- contact so every invoice for them goes to the same one.
-- Additive; re-runnable. All three tables already have RLS and their grants.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroInvoiceId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroInvoiceNumber" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroStatus" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroTotalCents" INTEGER;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroSentAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "xeroSentByName" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "xeroContactId" TEXT;
ALTER TABLE "Fleet" ADD COLUMN IF NOT EXISTS "xeroContactId" TEXT;
