-- A job card no longer needs a vehicle (2026-11-05): non-vehicle businesses open jobs for a customer alone.
-- Relaxing only: every existing row keeps its vehicle. Re-runnable. Both foreign keys (plain and the composite
-- tenant one) skip a NULL vehicleId, as they already do for bayId.
ALTER TABLE "JobCard" ALTER COLUMN "vehicleId" DROP NOT NULL;
