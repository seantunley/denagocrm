-- Add optional profile fields without changing existing accounts.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarRef" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarMimeType" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUpdatedAt" TIMESTAMP(3);
