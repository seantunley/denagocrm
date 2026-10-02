-- Gap audit #29: Telegram conversations had nowhere to land. A Telegram chat id
-- is unique only within the bot that sees it, i.e. within one tenant — the same
-- shape as X's user id, so the same tenant-scoped unique index.
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_tenantId_telegramChatId_key" ON "Contact"("tenantId", "telegramChatId");
