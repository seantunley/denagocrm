-- DAX conversations can be deleted (Sean, 2026-11-14: "no rename or delete"). Additive only: one nullable column.
-- A deleted conversation is kept for 60 days (restorable from the Ask page), then the nightly trash purge removes it
-- and its exchanges. The table's existing RLS policy (tenant isolation, forced) covers the new column unchanged.
ALTER TABLE "AssistantConversation" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
