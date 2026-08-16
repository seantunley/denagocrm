-- Signal-level Attention Centre state. Additive and nullable: existing rows
-- retain their legacy lead-level fields until they are next acted on.
ALTER TABLE "Lead"
  ADD COLUMN IF NOT EXISTS "attentionDispositions" JSONB;
