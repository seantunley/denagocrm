-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailOtpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "loginOtpExpires" TIMESTAMP(3),
ADD COLUMN     "loginOtpHash" TEXT,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'member',
ADD COLUMN     "totpBackupCodes" TEXT,
ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpSecret" TEXT;

