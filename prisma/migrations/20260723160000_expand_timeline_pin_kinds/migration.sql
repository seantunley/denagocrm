-- Timeline note pins were added after the original TimelinePin table, but the
-- database CHECK constraint still allowed only communication/activity. That made
-- pinning a contact or lead note fail at runtime with a PostgreSQL check violation.
-- Replay-safe: replace the named constraint with the complete application enum.

ALTER TABLE "TimelinePin"
  DROP CONSTRAINT IF EXISTS "TimelinePin_kind_check";

ALTER TABLE "TimelinePin"
  ADD CONSTRAINT "TimelinePin_kind_check"
  CHECK ("kind" IN ('communication', 'activity', 'contact_note', 'lead_note'))
  NOT VALID;

ALTER TABLE "TimelinePin"
  VALIDATE CONSTRAINT "TimelinePin_kind_check";
