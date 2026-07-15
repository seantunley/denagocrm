-- Workshop depth (phase 2): inspection checklists, additional-work approvals,
-- and check-in / check-out condition notes.

ALTER TABLE "JobCard" ADD COLUMN "checkinNotes" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "checkoutNotes" TEXT;

CREATE TABLE "JobCardInspectionItem" (
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ok',
  "notes" TEXT,
  "photoStoredName" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "jobCardId" TEXT NOT NULL,
  CONSTRAINT "JobCardInspectionItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobCardInspectionItem_jobCardId_idx" ON "JobCardInspectionItem"("jobCardId");
ALTER TABLE "JobCardInspectionItem" ADD CONSTRAINT "JobCardInspectionItem_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobCardApproval" (
  "id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedVia" TEXT,
  "decidedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "jobCardId" TEXT NOT NULL,
  CONSTRAINT "JobCardApproval_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobCardApproval_jobCardId_status_idx" ON "JobCardApproval"("jobCardId", "status");
ALTER TABLE "JobCardApproval" ADD CONSTRAINT "JobCardApproval_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
