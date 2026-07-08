-- Warranty claims + recalls / service bulletins
CREATE TABLE "WarrantyClaim" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "description" TEXT NOT NULL,
    "resolution" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleId" TEXT NOT NULL,
    "contactId" TEXT,
    "jobCardId" TEXT,
    "createdById" TEXT,
    CONSTRAINT "WarrantyClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WarrantyClaim_status_claimedAt_idx" ON "WarrantyClaim"("status", "claimedAt");
CREATE INDEX "WarrantyClaim_vehicleId_idx" ON "WarrantyClaim"("vehicleId");

ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Recall" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "Recall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Recall_active_idx" ON "Recall"("active");
