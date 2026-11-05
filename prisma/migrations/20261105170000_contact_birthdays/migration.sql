-- Customer birthdays (2026-11-05): day and month, with the year when known. Additive only; re-runnable.
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "birthDay" INTEGER;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "birthMonth" INTEGER;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "birthYear" INTEGER;
-- "Whose birthday is today" is a lookup on month and day within a workspace.
CREATE INDEX IF NOT EXISTS "Contact_tenantId_birthMonth_birthDay_idx" ON "Contact"("tenantId", "birthMonth", "birthDay");
