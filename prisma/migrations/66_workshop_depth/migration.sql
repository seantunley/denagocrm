-- Workshop depth (phase 1): job-card workflow, workshop bays and a technician time clock.

-- Workshop bays.
CREATE TABLE "WorkshopBay" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#0ea5e9',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkshopBay_pkey" PRIMARY KEY ("id")
);

-- Job-card workshop-depth columns.
ALTER TABLE "JobCard" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "JobCard" ADD COLUMN "estimatedHours" DOUBLE PRECISION;
ALTER TABLE "JobCard" ADD COLUMN "labourRateCents" INTEGER;
ALTER TABLE "JobCard" ADD COLUMN "bayId" TEXT;

-- Migrate the legacy 3-state status vocabulary to the workshop workflow.
UPDATE "JobCard" SET "status" = CASE "status"
  WHEN 'open' THEN 'booking'
  WHEN 'in_progress' THEN 'repair'
  WHEN 'completed' THEN 'collected'
  ELSE "status" END;
ALTER TABLE "JobCard" ALTER COLUMN "status" SET DEFAULT 'booking';

CREATE INDEX "JobCard_bayId_idx" ON "JobCard"("bayId");
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_bayId_fkey" FOREIGN KEY ("bayId") REFERENCES "WorkshopBay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Technician time clock.
CREATE TABLE "JobCardTimeEntry" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "jobCardId" TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  CONSTRAINT "JobCardTimeEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobCardTimeEntry_jobCardId_idx" ON "JobCardTimeEntry"("jobCardId");
CREATE INDEX "JobCardTimeEntry_technicianId_endedAt_idx" ON "JobCardTimeEntry"("technicianId", "endedAt");
ALTER TABLE "JobCardTimeEntry" ADD CONSTRAINT "JobCardTimeEntry_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobCardTimeEntry" ADD CONSTRAINT "JobCardTimeEntry_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
