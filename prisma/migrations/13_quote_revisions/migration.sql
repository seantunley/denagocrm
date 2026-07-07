-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "revisionOfId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

