-- DAX batch 2: what the assistant has learned carries where it came from,
-- when it was last confirmed and used, an optional last day, and a hold for
-- learning that contradicts an approved entry. Additive only; re-runnable.

-- The backfill below reads and writes existing rows of a FORCE-RLS table.
SET app.bypass_rls = 'on';

ALTER TABLE "AssistantNote" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'learned';
ALTER TABLE "AssistantNote" ADD COLUMN IF NOT EXISTS "lastConfirmedAt" TIMESTAMP(3);
ALTER TABLE "AssistantNote" ADD COLUMN IF NOT EXISTS "validUntil" DATE;
ALTER TABLE "AssistantNote" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);
ALTER TABLE "AssistantNote" ADD COLUMN IF NOT EXISTS "conflictsWithId" TEXT;

-- Existing rows: work the source out from how each one was written.
-- No person behind it → the nightly tidy-up wrote it.
UPDATE "AssistantNote" SET "source" = 'tidy'
WHERE "source" = 'learned' AND "createdById" IS NULL;
-- A profile entry the person saved about themselves (written and approved by them).
UPDATE "AssistantNote" SET "source" = 'person'
WHERE "source" = 'learned' AND "kind" = 'profile'
  AND "userId" = "createdById" AND "reviewedById" = "createdById";
-- Taught by the owner: created already approved, by the person who approved it.
UPDATE "AssistantNote" SET "source" = 'owner'
WHERE "source" = 'learned' AND "kind" <> 'profile' AND "status" = 'approved'
  AND "reviewedById" = "createdById" AND "reviewedAt" - "createdAt" < interval '5 seconds';

-- Approval was the last confirmation so far.
UPDATE "AssistantNote" SET "lastConfirmedAt" = "reviewedAt"
WHERE "lastConfirmedAt" IS NULL AND "status" = 'approved';

RESET app.bypass_rls;
