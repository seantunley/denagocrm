-- Idempotency for email→ticket filing: remember the source email's Message-ID
-- on the case message it produced. A unique index makes re-processing the same
-- email (a cron retry, an overlapping run, or a replay after a poison message)
-- a no-op instead of a duplicate ticket or auto-reply. Postgres keeps NULLs
-- distinct, so messages with no Message-ID (portal/staff replies) are unaffected.
ALTER TABLE "CustomerCaseMessage" ADD COLUMN IF NOT EXISTS "sourceMessageId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerCaseMessage_sourceMessageId_key"
  ON "CustomerCaseMessage" ("sourceMessageId");
