-- Proactive DAX (second review of #896): an alert held overnight is checked
-- again before it is sent or folded into a morning brief — is the person still
-- a member, and may they still open the deal or customer it is about? For
-- that the alert keeps which record it is about. Additive only; re-runnable.

ALTER TABLE "AssistantProactiveAlert" ADD COLUMN IF NOT EXISTS "leadId" TEXT;
ALTER TABLE "AssistantProactiveAlert" ADD COLUMN IF NOT EXISTS "contactId" TEXT;
