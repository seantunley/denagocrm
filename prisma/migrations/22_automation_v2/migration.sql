-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "conditionSources" TEXT,
ADD COLUMN     "minValueCents" INTEGER,
ADD COLUMN     "pushMessage" TEXT;

