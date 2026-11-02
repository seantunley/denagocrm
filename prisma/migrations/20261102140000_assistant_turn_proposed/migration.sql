-- What DAX offered in each answer (Sean, 2026-11-02: outcome tracking, step 1 — measure and show):
-- each card's kind and the deal or customer it was on, by id, never by name. Settings → Assistant counts
-- it beside what was confirmed. Nothing reads it to change what DAX suggests.
-- Additive only; re-runnable. AssistantTurn's row-level security already covers a new column.

ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "proposed" JSONB;
