-- Delivery of the assistant's own updates to a linked phone, made dependable:
-- a long answer is several WhatsApp messages and must not end half-sent, and a
-- sender that stops must not leave an update claimed for ever. Additive,
-- re-runnable.

-- A sender is working on it now. A claim older than a few minutes is taken over.
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "whatsappClaimedAt" TIMESTAMP(3);
-- How many of its messages have gone: a send that stopped half-way resumes here.
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "whatsappPartsSent" INTEGER NOT NULL DEFAULT 0;
-- When the "you have an update" template last failed for a passing reason.
ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "nudgeFailedAt" TIMESTAMP(3);
