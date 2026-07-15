-- Workshop depth (phase 3): part reservations, service packages, subcontracting.

ALTER TABLE "JobCard" ADD COLUMN "isSubcontracted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobCard" ADD COLUMN "subcontractor" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "subCostCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PartReservation" (
  "id" TEXT NOT NULL,
  "qty" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "partId" TEXT NOT NULL,
  "jobCardId" TEXT NOT NULL,
  CONSTRAINT "PartReservation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartReservation_partId_status_idx" ON "PartReservation"("partId", "status");
CREATE INDEX "PartReservation_jobCardId_status_idx" ON "PartReservation"("jobCardId", "status");
ALTER TABLE "PartReservation" ADD CONSTRAINT "PartReservation_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartReservation" ADD CONSTRAINT "PartReservation_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ServicePackage" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServicePackage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServicePackageItem" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'part',
  "description" TEXT NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
  "partId" TEXT,
  "packageId" TEXT NOT NULL,
  CONSTRAINT "ServicePackageItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ServicePackageItem_packageId_idx" ON "ServicePackageItem"("packageId");
ALTER TABLE "ServicePackageItem" ADD CONSTRAINT "ServicePackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ServicePackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
