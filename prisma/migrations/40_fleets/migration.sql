-- Fleet / B2B accounts grouping many carts under one organisation
CREATE TABLE "Fleet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "notes" TEXT,
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Fleet_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Vehicle" ADD COLUMN "fleetId" TEXT;
CREATE INDEX "Vehicle_fleetId_idx" ON "Vehicle"("fleetId");

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "Fleet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
