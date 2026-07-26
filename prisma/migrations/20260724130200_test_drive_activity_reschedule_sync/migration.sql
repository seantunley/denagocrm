-- Preserve the dedicated booking's duration and operational state when an older
-- calendar/pipeline action reschedules or updates its linked Activity.

CREATE OR REPLACE FUNCTION sync_test_drive_from_activity() RETURNS trigger AS $$
DECLARE linked_product TEXT;
BEGIN
  IF NEW."type" <> 'test_drive' OR NEW."contactId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "productId" INTO linked_product FROM "Lead" WHERE "id" = NEW."leadId";

  INSERT INTO "TestDriveBooking" (
    "id", "tenantId", "reference", "status", "leadId", "contactId", "branch",
    "productId", "salespersonId", "activityId", "scheduledStart", "expectedReturnAt",
    "actualReturnAt", "createdAt", "updatedAt"
  ) VALUES (
    'td_' || SUBSTRING(md5(NEW."id") FROM 1 FOR 24),
    NEW."tenantId",
    'TD-' || UPPER(SUBSTRING(md5(NEW."id") FROM 1 FOR 8)),
    CASE WHEN NEW."status" = 'done' THEN 'completed' WHEN NEW."status" = 'canceled' THEN 'cancelled' ELSE 'booked' END,
    NEW."leadId",
    NEW."contactId",
    COALESCE(NULLIF(NEW."location", ''), 'Unassigned'),
    linked_product,
    NEW."assignedToId",
    NEW."id",
    NEW."dueDate",
    NEW."dueDate" + INTERVAL '1 hour',
    CASE WHEN NEW."status" = 'done' THEN COALESCE(NEW."doneAt", NEW."dueDate") ELSE NULL END,
    NEW."createdAt",
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("activityId") DO UPDATE SET
    "tenantId" = EXCLUDED."tenantId",
    "status" = CASE
      WHEN "TestDriveBooking"."status" = 'completed' THEN 'completed'
      WHEN "TestDriveBooking"."status" = 'checked_out' THEN 'checked_out'
      WHEN "TestDriveBooking"."status" = 'confirmed' AND EXCLUDED."status" = 'booked' THEN 'confirmed'
      WHEN "TestDriveBooking"."status" = 'no_show' AND EXCLUDED."status" = 'cancelled' THEN 'no_show'
      ELSE EXCLUDED."status"
    END,
    "leadId" = EXCLUDED."leadId",
    "contactId" = EXCLUDED."contactId",
    "branch" = EXCLUDED."branch",
    "productId" = COALESCE(EXCLUDED."productId", "TestDriveBooking"."productId"),
    "salespersonId" = EXCLUDED."salespersonId",
    "expectedReturnAt" = "TestDriveBooking"."expectedReturnAt"
      + (EXCLUDED."scheduledStart" - "TestDriveBooking"."scheduledStart"),
    "scheduledStart" = EXCLUDED."scheduledStart",
    "actualReturnAt" = COALESCE(EXCLUDED."actualReturnAt", "TestDriveBooking"."actualReturnAt"),
    "updatedAt" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
