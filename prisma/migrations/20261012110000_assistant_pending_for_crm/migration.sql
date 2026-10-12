-- A task the assistant proposed on WhatsApp that is only done in the CRM is now
-- kept as a card on the Ask page instead of being named and forgotten.
-- One additive column, re-runnable. Existing rows are WhatsApp offers: false.
ALTER TABLE "AssistantPendingAction" ADD COLUMN IF NOT EXISTS "forCrm" BOOLEAN NOT NULL DEFAULT false;
