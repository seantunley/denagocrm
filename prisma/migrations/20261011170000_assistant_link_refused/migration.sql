-- Why the last code a person sent did not link their phone, so the Ask page can
-- say so. Additive and nullable: null means "nothing refused".
ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "refusedReason" TEXT;
