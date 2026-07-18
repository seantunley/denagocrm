-- Telegram Mini App: link a Telegram account to a CRM user for password-less
-- auto-login, plus a one-time code used to establish that link. All additive
-- and nullable — safe on live data.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramUserId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramLinkCode" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramLinkExpires" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramUserId_key" ON "User"("telegramUserId");
