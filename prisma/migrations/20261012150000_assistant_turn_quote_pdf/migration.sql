-- The quote whose PDF is delivered with an assistant update (a draft the
-- assistant built for a member of staff, sent to THEIR linked WhatsApp).
-- One additive nullable column, re-runnable. Existing rows stay null.
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "quoteId" TEXT;
