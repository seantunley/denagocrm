-- Workshop depth (phase 4): comeback tracking + warranty recovery fields.

ALTER TABLE "JobCard" ADD COLUMN "comebackOfId" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "underWarranty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobCard" ADD COLUMN "warrantyRecoveredCents" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "JobCard_comebackOfId_idx" ON "JobCard"("comebackOfId");
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_comebackOfId_fkey" FOREIGN KEY ("comebackOfId") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
