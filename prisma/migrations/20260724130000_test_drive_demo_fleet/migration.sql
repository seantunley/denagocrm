-- Dedicated test-drive and demo-fleet operations.
-- Additive: the existing Activity calendar remains linked through activityId.

CREATE TABLE "DemoVehicle" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "name" TEXT NOT NULL,
  "productId" TEXT,
  "stockUnitId" TEXT,
  "vin" TEXT,
  "regNumber" TEXT,
  "color" TEXT,
  "branch" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "odometerKm" INTEGER NOT NULL DEFAULT 0,
  "batteryLevelPct" INTEGER,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "DemoVehicle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DemoVehicle_status_check" CHECK ("status" IN ('active','maintenance','unavailable','retired')),
  CONSTRAINT "DemoVehicle_odometer_check" CHECK ("odometerKm" >= 0),
  CONSTRAINT "DemoVehicle_battery_check" CHECK ("batteryLevelPct" IS NULL OR "batteryLevelPct" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "DemoVehicle_stockUnitId_key" ON "DemoVehicle"("stockUnitId") WHERE "stockUnitId" IS NOT NULL AND "deletedAt" IS NULL;
CREATE INDEX "DemoVehicle_tenantId_idx" ON "DemoVehicle"("tenantId");
CREATE INDEX "DemoVehicle_status_branch_idx" ON "DemoVehicle"("status", "branch");
CREATE INDEX "DemoVehicle_productId_idx" ON "DemoVehicle"("productId");

CREATE TABLE "TestDriveBooking" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "reference" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'booked',
  "leadId" TEXT,
  "contactId" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "demoVehicleId" TEXT,
  "productId" TEXT,
  "salespersonId" TEXT NOT NULL,
  "accompanyingSalespersonId" TEXT,
  "activityId" TEXT,
  "scheduledStart" TIMESTAMP(3) NOT NULL,
  "expectedReturnAt" TIMESTAMP(3) NOT NULL,
  "actualStartAt" TIMESTAMP(3),
  "actualReturnAt" TIMESTAMP(3),
  "cancellationReason" TEXT,
  "noShowReason" TEXT,
  "driverLicenceNumber" TEXT,
  "driverLicenceExpiry" TIMESTAMP(3),
  "identityVerifiedAt" TIMESTAMP(3),
  "identityVerifiedById" TEXT,
  "indemnityStatus" TEXT NOT NULL DEFAULT 'pending',
  "emergencyContactName" TEXT,
  "emergencyContactPhone" TEXT,
  "startOdometerKm" INTEGER,
  "startBatteryPct" INTEGER,
  "existingDamage" TEXT,
  "accessoriesSupplied" TEXT,
  "intendedRoute" TEXT,
  "returnOdometerKm" INTEGER,
  "returnBatteryPct" INTEGER,
  "returnCondition" TEXT,
  "newDamage" TEXT,
  "incidentReport" TEXT,
  "cleaningRequired" BOOLEAN NOT NULL DEFAULT false,
  "chargingRequired" BOOLEAN NOT NULL DEFAULT false,
  "customerFeedback" TEXT,
  "salesOutcome" TEXT,
  "convertedQuoteId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "TestDriveBooking_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TestDriveBooking_status_check" CHECK ("status" IN ('booked','confirmed','checked_out','completed','cancelled','no_show')),
  CONSTRAINT "TestDriveBooking_indemnity_check" CHECK ("indemnityStatus" IN ('pending','signed','waived','not_required')),
  CONSTRAINT "TestDriveBooking_outcome_check" CHECK ("salesOutcome" IS NULL OR "salesOutcome" IN ('follow_up','quote_created','sale_won','no_interest','undecided')),
  CONSTRAINT "TestDriveBooking_time_check" CHECK ("expectedReturnAt" > "scheduledStart"),
  CONSTRAINT "TestDriveBooking_start_odometer_check" CHECK ("startOdometerKm" IS NULL OR "startOdometerKm" >= 0),
  CONSTRAINT "TestDriveBooking_return_odometer_check" CHECK ("returnOdometerKm" IS NULL OR "returnOdometerKm" >= 0),
  CONSTRAINT "TestDriveBooking_start_battery_check" CHECK ("startBatteryPct" IS NULL OR "startBatteryPct" BETWEEN 0 AND 100),
  CONSTRAINT "TestDriveBooking_return_battery_check" CHECK ("returnBatteryPct" IS NULL OR "returnBatteryPct" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "TestDriveBooking_reference_key" ON "TestDriveBooking"("reference");
CREATE UNIQUE INDEX "TestDriveBooking_activityId_key" ON "TestDriveBooking"("activityId") WHERE "activityId" IS NOT NULL;
CREATE INDEX "TestDriveBooking_tenantId_idx" ON "TestDriveBooking"("tenantId");
CREATE INDEX "TestDriveBooking_schedule_status_idx" ON "TestDriveBooking"("scheduledStart", "status");
CREATE INDEX "TestDriveBooking_vehicle_schedule_idx" ON "TestDriveBooking"("demoVehicleId", "scheduledStart");
CREATE INDEX "TestDriveBooking_leadId_idx" ON "TestDriveBooking"("leadId");
CREATE INDEX "TestDriveBooking_contactId_idx" ON "TestDriveBooking"("contactId");
CREATE INDEX "TestDriveBooking_salespersonId_idx" ON "TestDriveBooking"("salespersonId");
CREATE INDEX "TestDriveBooking_convertedQuoteId_idx" ON "TestDriveBooking"("convertedQuoteId");

ALTER TABLE "TestDriveBooking"
  ADD CONSTRAINT "TestDriveBooking_demoVehicleId_fkey"
  FOREIGN KEY ("demoVehicleId") REFERENCES "DemoVehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TestDriveAsset" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "bookingId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "storedName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "note" TEXT,
  "uploadedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TestDriveAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TestDriveAsset_kind_check" CHECK ("kind" IN ('driver_licence','start_condition','return_condition','incident','other')),
  CONSTRAINT "TestDriveAsset_size_check" CHECK ("sizeBytes" >= 0)
);

CREATE UNIQUE INDEX "TestDriveAsset_storedName_key" ON "TestDriveAsset"("storedName");
CREATE INDEX "TestDriveAsset_tenantId_idx" ON "TestDriveAsset"("tenantId");
CREATE INDEX "TestDriveAsset_booking_kind_idx" ON "TestDriveAsset"("bookingId", "kind");
ALTER TABLE "TestDriveAsset"
  ADD CONSTRAINT "TestDriveAsset_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "TestDriveBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing test-drive activities become dedicated bookings immediately.
INSERT INTO "TestDriveBooking" (
  "id", "tenantId", "reference", "status", "leadId", "contactId", "branch",
  "productId", "salespersonId", "activityId", "scheduledStart", "expectedReturnAt",
  "actualReturnAt", "createdAt", "updatedAt"
)
SELECT
  'td_' || SUBSTRING(md5(a."id") FROM 1 FOR 24),
  a."tenantId",
  'TD-' || UPPER(SUBSTRING(md5(a."id") FROM 1 FOR 8)),
  CASE WHEN a."status" = 'done' THEN 'completed' WHEN a."status" = 'canceled' THEN 'cancelled' ELSE 'booked' END,
  a."leadId",
  a."contactId",
  COALESCE(NULLIF(a."location", ''), 'Unassigned'),
  l."productId",
  a."assignedToId",
  a."id",
  a."dueDate",
  a."dueDate" + INTERVAL '1 hour',
  CASE WHEN a."status" = 'done' THEN COALESCE(a."doneAt", a."dueDate") ELSE NULL END,
  a."createdAt",
  CURRENT_TIMESTAMP
FROM "Activity" a
LEFT JOIN "Lead" l ON l."id" = a."leadId"
WHERE a."type" = 'test_drive' AND a."contactId" IS NOT NULL
ON CONFLICT ("activityId") DO NOTHING;

-- Keep the legacy calendar workflow compatible. Any test-drive Activity created by
-- the pipeline board is automatically mirrored into the dedicated module.
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
    "status" = EXCLUDED."status",
    "leadId" = EXCLUDED."leadId",
    "contactId" = EXCLUDED."contactId",
    "branch" = EXCLUDED."branch",
    "productId" = COALESCE(EXCLUDED."productId", "TestDriveBooking"."productId"),
    "salespersonId" = EXCLUDED."salespersonId",
    "scheduledStart" = EXCLUDED."scheduledStart",
    "actualReturnAt" = EXCLUDED."actualReturnAt",
    "updatedAt" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Activity_sync_test_drive_booking"
AFTER INSERT OR UPDATE OF "type", "status", "leadId", "contactId", "location", "assignedToId", "dueDate", "doneAt"
ON "Activity"
FOR EACH ROW EXECUTE FUNCTION sync_test_drive_from_activity();
