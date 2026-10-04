-- A linked WhatsApp number is a SIGN-IN, and must die with the others: the
-- account's sessionVersion at the moment of linking. Any later bump — password
-- change or reset, "sign out everywhere", disable — no longer matches, and the
-- number stops reaching the assistant. Additive only.
ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER;
