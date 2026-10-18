-- Proactive DAX (review of #896): a morning brief being written is not a brief
-- written. "claimedAt" is the lease of whoever is writing it now; deliveredAt
-- stays "done". A failed brief gives the lease back, and a lease past its time
-- (a worker that died) can be taken again — so a brief is retried until 11:00,
-- never written twice. Additive only; re-runnable.

ALTER TABLE "AssistantProactiveAlert" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
