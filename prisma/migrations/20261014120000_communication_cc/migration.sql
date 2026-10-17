-- Who a sent email was copied to, kept apart from its words (review of #889):
-- Reply all reads this, never "[Cc: …]" text in a body a customer's email can
-- make say anything. One additive nullable column, re-runnable. Existing rows
-- stay null (they get Reply, not Reply all).
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "cc" TEXT;
