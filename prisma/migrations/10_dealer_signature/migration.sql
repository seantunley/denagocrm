-- AlterTable
ALTER TABLE "User" ADD COLUMN     "drawnSignatureRef" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "dealerSignatureRef" TEXT,
ADD COLUMN     "dealerSignedAt" TIMESTAMP(3),
ADD COLUMN     "dealerSignedByName" TEXT;

