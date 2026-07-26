-- Keep the requested model aligned with the physical demo vehicle and prevent
-- status changes that would strand active bookings.

CREATE OR REPLACE FUNCTION prevent_demo_vehicle_booking_overlap() RETURNS trigger AS $$
DECLARE
  demo_product_id TEXT;
  demo_status TEXT;
BEGIN
  IF NEW."demoVehicleId" IS NULL
     OR NEW."deletedAt" IS NOT NULL
     OR NEW."status" NOT IN ('booked','confirmed','checked_out') THEN
    RETURN NEW;
  END IF;

  SELECT "productId", "status"
  INTO demo_product_id, demo_status
  FROM "DemoVehicle"
  WHERE "id" = NEW."demoVehicleId" AND "deletedAt" IS NULL;

  IF demo_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'The selected demo vehicle is unavailable.';
  END IF;
  IF demo_status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only active demo vehicles can be booked.';
  END IF;

  NEW."productId" := COALESCE(demo_product_id, NEW."productId");

  PERFORM pg_advisory_xact_lock(hashtext(NEW."demoVehicleId"));

  IF EXISTS (
    SELECT 1
    FROM "TestDriveBooking" existing
    WHERE existing."id" <> NEW."id"
      AND existing."demoVehicleId" = NEW."demoVehicleId"
      AND existing."deletedAt" IS NULL
      AND existing."status" IN ('booked','confirmed','checked_out')
      AND existing."scheduledStart" < NEW."expectedReturnAt"
      AND existing."expectedReturnAt" > NEW."scheduledStart"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'The demo vehicle is already booked for this time range.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_unavailable_demo_with_live_bookings() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'active'
     AND (OLD."status" IS DISTINCT FROM NEW."status")
     AND EXISTS (
       SELECT 1
       FROM "TestDriveBooking" booking
       WHERE booking."demoVehicleId" = NEW."id"
         AND booking."deletedAt" IS NULL
         AND booking."status" IN ('booked','confirmed','checked_out')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Reassign or close the demo vehicle''s active bookings before changing its availability.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DemoVehicle_prevent_unavailable_with_live_bookings" ON "DemoVehicle";
CREATE TRIGGER "DemoVehicle_prevent_unavailable_with_live_bookings"
BEFORE UPDATE OF "status" ON "DemoVehicle"
FOR EACH ROW EXECUTE FUNCTION prevent_unavailable_demo_with_live_bookings();
