-- Round-2 hardening for the email→ticket pipeline.

-- 1) Durable idempotency for the TIMELINE path. Communication.messageId keeps
--    only a plain index and can legitimately repeat across historical rows, so
--    it can't enforce uniqueness. Add a dedicated key (Message-ID, or a content
--    hash when the mail has none) with a unique index. NULLs stay distinct, so
--    existing rows (all NULL) and non-email messages are unaffected.
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Communication_dedupeKey_key"
  ON "Communication" ("dedupeKey");

-- 2) A support mailbox's inbound address is a routing key: it must resolve to
--    exactly one mailbox. Enforce case-insensitive uniqueness so duplicate
--    aliases can't be created and route ambiguously.
CREATE UNIQUE INDEX IF NOT EXISTS "SupportMailbox_email_lower_key"
  ON "SupportMailbox" (lower("email")) WHERE "email" IS NOT NULL;
