-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "signToken" TEXT,
ADD COLUMN     "signatureRef" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedByName" TEXT,
ADD COLUMN     "signerIp" TEXT;

-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "signToken" TEXT,
ADD COLUMN     "signatureRef" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedByName" TEXT,
ADD COLUMN     "signerIp" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Quote_signToken_key" ON "Quote"("signToken");

-- CreateIndex
CREATE UNIQUE INDEX "JobCard_signToken_key" ON "JobCard"("signToken");

