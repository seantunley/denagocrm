-- An inspection item needs a version OF ITS OWN.
--
-- Offline replays were conflict-checked against the parent JobCard's updatedAt,
-- but setInspectionItem and uploadInspectionPhoto write only
-- JobCardInspectionItem — the parent's timestamp never moves. So a technician
-- who changed an item's status or notes after a device took its snapshot left
-- the guard still matching, and the offline replay overwrote their result with
-- no conflict reported at all.
--
-- Additive and safe on a live table: the column is added with a default, so
-- existing rows get a value without a rewrite of application data, and nothing
-- reads it until the code that ships with this migration does.
ALTER TABLE "JobCardInspectionItem"
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
