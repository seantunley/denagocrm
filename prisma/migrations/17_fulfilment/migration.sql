-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryScheduledFor" TIMESTAMP(3),
ADD COLUMN     "depositPaidAt" TIMESTAMP(3),
ADD COLUMN     "invoicedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "quoteId" TEXT,
ADD COLUMN     "tag" TEXT;

