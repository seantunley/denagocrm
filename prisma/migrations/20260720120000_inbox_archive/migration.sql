-- Archive social-inbox threads without deleting them. Additive & idempotent.
--   archivedAt: when the thread carrying this message was archived (NULL = active).
--               The inbox hides archived threads by default and offers an
--               "Archived" view; nothing is ever deleted.
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Communication_archivedAt_idx" ON "Communication" ("archivedAt");
