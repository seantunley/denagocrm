-- The legacy pipeline flow deletes a planned test-drive Activity when a lead is
-- moved backwards. Preserve the dedicated operational record and close it rather
-- than leaving a stale active booking.

CREATE OR REPLACE FUNCTION cancel_test_drive_from_activity_delete() RETURNS trigger AS $$
BEGIN
  IF OLD."type" = 'test_drive' THEN
    UPDATE "TestDriveBooking"
    SET
      "status" = 'cancelled',
      "cancellationReason" = COALESCE(
        "cancellationReason",
        'Linked calendar activity was removed by the legacy pipeline workflow.'
      ),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "activityId" = OLD."id"
      AND "deletedAt" IS NULL
      AND "status" IN ('booked', 'confirmed');
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Activity_cancel_test_drive_booking_on_delete" ON "Activity";
CREATE TRIGGER "Activity_cancel_test_drive_booking_on_delete"
AFTER DELETE ON "Activity"
FOR EACH ROW EXECUTE FUNCTION cancel_test_drive_from_activity_delete();
