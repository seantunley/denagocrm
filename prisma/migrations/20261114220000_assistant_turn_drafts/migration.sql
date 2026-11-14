-- DAX keeps the drafts it wrote, word for word (DAX_Conversational_Upgrades.md §1, Sean 2026-11-14): each answer's
-- draft_message cards — the deal they are for, subject, body and Cc — so "change only the greeting" four turns later
-- starts from the exact text the person saw. Additive only: one nullable column on a table that already has its RLS
-- policy (AssistantTurn_tenant_isolation, FORCE) and its grants; existing turns keep NULL. No data is moved.

ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "drafts" JSONB;
