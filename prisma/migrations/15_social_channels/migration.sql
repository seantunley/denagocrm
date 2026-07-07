-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "instagramId" TEXT,
ADD COLUMN     "messengerPsid" TEXT;

-- CreateTable
CREATE TABLE "GoogleReview" (
    "id" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "raw" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleReview_externalKey_key" ON "GoogleReview"("externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_messengerPsid_key" ON "Contact"("messengerPsid");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instagramId_key" ON "Contact"("instagramId");

