-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "declinedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3),
ADD COLUMN     "signLinkCreatedAt" TIMESTAMP(3),
ADD COLUMN     "signedPdfHash" TEXT,
ADD COLUMN     "signerUserAgent" TEXT,
ADD COLUMN     "viewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "signedPdfHash" TEXT,
ADD COLUMN     "signerUserAgent" TEXT,
ADD COLUMN     "viewedAt" TIMESTAMP(3);

