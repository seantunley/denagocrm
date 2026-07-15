-- Add workshop depth fields to JobCard
ALTER TABLE "JobCard" ADD COLUMN "estimatedHours" DOUBLE PRECISION;
ALTER TABLE "JobCard" ADD COLUMN "actualHours" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "JobCard" ADD COLUMN "labourRateCents" INTEGER DEFAULT 0;
ALTER TABLE "JobCard" ADD COLUMN "bay" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "priority" TEXT DEFAULT 'normal';
ALTER TABLE "JobCard" ADD COLUMN "additionalApprovalRequired" BOOLEAN DEFAULT false;
ALTER TABLE "JobCard" ADD COLUMN "additionalApprovedAt" TIMESTAMP(3);
ALTER TABLE "JobCard" ADD COLUMN "additionalApprovedById" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "isSubcontracted" BOOLEAN DEFAULT false;
ALTER TABLE "JobCard" ADD COLUMN "subcontractor" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "subCostCents" INTEGER DEFAULT 0;
ALTER TABLE "JobCard" ADD COLUMN "checklist" JSONB;

-- New table for time entries
CREATE TABLE "JobCardTimeEntry" (
  "id" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "hours" DOUBLE PRECISION,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "jobCardId" TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,

  CONSTRAINT "JobCardTimeEntry_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "JobCardTimeEntry" ADD CONSTRAINT "JobCardTimeEntry_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobCardTimeEntry" ADD CONSTRAINT "JobCardTimeEntry_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "JobCardTimeEntry_jobCardId_idx" ON "JobCardTimeEntry"("jobCardId");
CREATE INDEX "JobCardTimeEntry_technicianId_idx" ON "JobCardTimeEntry"("technicianId");

-- Update default status
ALTER TABLE "JobCard" ALTER COLUMN "status" SET DEFAULT 'booking';