-- Staff calendar availability.
--
-- Activity remains the single calendar source of truth. Internal availability
-- records have no Lead/Contact, carry availabilityBlock=true, and use dueDate /
-- endDate as a real half-open interval [start,end). Existing activities remain
-- valid: endDate is nullable and availabilityBlock/allDay default false.

ALTER TABLE "Activity"
  ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "allDay" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "availabilityBlock" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Activity_assignedToId_dueDate_status_idx"
  ON "Activity"("assignedToId", "dueDate", "status");

CREATE INDEX IF NOT EXISTS "Activity_availabilityBlock_dueDate_endDate_idx"
  ON "Activity"("availabilityBlock", "dueDate", "endDate");
