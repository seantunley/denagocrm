-- When a quote version was last emailed from "Email quote", and to which address,
-- so the quote's own screen can say it was sent. Two additive nullable columns,
-- re-runnable. Existing quotes stay null: nothing is guessed for the past.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "emailedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "emailedTo" TEXT;
