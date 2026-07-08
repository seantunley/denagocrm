-- EV battery health snapshots per vehicle
CREATE TABLE "BatteryCheck" (
    "id" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packSerial" TEXT,
    "stateOfHealth" INTEGER,
    "voltage" DOUBLE PRECISION,
    "cycles" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleId" TEXT NOT NULL,
    "jobCardId" TEXT,
    "recordedById" TEXT,
    CONSTRAINT "BatteryCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BatteryCheck_vehicleId_checkedAt_idx" ON "BatteryCheck"("vehicleId", "checkedAt");

ALTER TABLE "BatteryCheck" ADD CONSTRAINT "BatteryCheck_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
