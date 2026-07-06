-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByName" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByName" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByName" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByName" TEXT;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByName" TEXT;

-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByName" TEXT;

