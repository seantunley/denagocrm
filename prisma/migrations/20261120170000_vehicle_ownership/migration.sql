-- Transfer a vehicle and its warranty to a new owner (warranty-transfer-brief.md, PR 1, 2026-11-20).
-- Who owned a vehicle when. Additive: a new table, filled with one open row per existing vehicle; nothing existing
-- changes. Vehicle."contactId" stays the current owner, so every reader of it is unaffected.

SET app.bypass_rls = 'on';

CREATE TABLE IF NOT EXISTS "VehicleOwnership" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "vehicleId" TEXT NOT NULL,
  "contactId" TEXT,
  "ownedFrom" TIMESTAMP(3) NOT NULL,
  "ownedUntil" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  "odometerKm" INTEGER,
  "note" TEXT,
  "proofDocumentId" TEXT,
  "warranty" TEXT NOT NULL DEFAULT 'carried',
  "fleetIdBefore" TEXT,
  "transferredById" TEXT,
  "transferredByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt" TIMESTAMP(3),
  "reversedByName" TEXT,
  CONSTRAINT "VehicleOwnership_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "VehicleOwnership_vehicleId_idx" ON "VehicleOwnership"("vehicleId");
CREATE INDEX IF NOT EXISTS "VehicleOwnership_contactId_idx" ON "VehicleOwnership"("contactId");
CREATE INDEX IF NOT EXISTS "VehicleOwnership_tenantId_idx" ON "VehicleOwnership"("tenantId");

-- EXACTLY ONE CURRENT OWNER PER VEHICLE, held by the database: two transfers at once cannot both leave an open row.
CREATE UNIQUE INDEX IF NOT EXISTS "VehicleOwnership_one_open_per_vehicle"
  ON "VehicleOwnership"("vehicleId") WHERE "ownedUntil" IS NULL;

-- The history goes with its vehicle. A purged contact leaves the row (the vehicle's history) without the person.
DO $$ BEGIN
  ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Never another workspace's vehicle or contact (the composite tenant keys, as on every tenant-scoped child).
DO $$ BEGIN
  ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE SET NULL ("contactId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One workspace never reads or writes another's (the standard tenant policy).
ALTER TABLE "VehicleOwnership" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "VehicleOwnership_tenant_isolation" ON "VehicleOwnership";
CREATE POLICY "VehicleOwnership_tenant_isolation" ON "VehicleOwnership"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "VehicleOwnership" FORCE ROW LEVEL SECURITY;

-- EVERY NEW VEHICLE STARTS WITH ITS FIRST OWNER — whichever path creates it (Add vehicle, a delivery, an import, one
-- not written yet). Runs as the inserting session, so the row is checked by the same policy as the vehicle.
CREATE OR REPLACE FUNCTION vehicle_ownership_open_first() RETURNS trigger AS $$
BEGIN
  INSERT INTO "VehicleOwnership" ("id", "tenantId", "vehicleId", "contactId", "ownedFrom", "reason")
  VALUES ('vo_' || NEW."id", NEW."tenantId", NEW."id", NEW."contactId", COALESCE(NEW."purchaseDate", NEW."createdAt"), 'registered')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Vehicle_open_first_ownership" ON "Vehicle";
CREATE TRIGGER "Vehicle_open_first_ownership" AFTER INSERT ON "Vehicle"
  FOR EACH ROW EXECUTE FUNCTION vehicle_ownership_open_first();

-- Every existing vehicle (trashed ones too): one open row for its current owner, from its purchase date (else when it
-- was added). Re-runnable: a vehicle that already has an open row is skipped.
INSERT INTO "VehicleOwnership" ("id", "tenantId", "vehicleId", "contactId", "ownedFrom", "reason")
SELECT 'vo_' || v."id", v."tenantId", v."id", v."contactId", COALESCE(v."purchaseDate", v."createdAt"), 'registered'
FROM "Vehicle" v
WHERE NOT EXISTS (SELECT 1 FROM "VehicleOwnership" o WHERE o."vehicleId" = v."id" AND o."ownedUntil" IS NULL)
ON CONFLICT DO NOTHING;

-- Proven here, not assumed: a vehicle without exactly one open row fails the migration (and so the deploy).
DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT count(*) INTO bad FROM "Vehicle" v
  WHERE (SELECT count(*) FROM "VehicleOwnership" o WHERE o."vehicleId" = v."id" AND o."ownedUntil" IS NULL) <> 1;
  IF bad > 0 THEN
    RAISE EXCEPTION 'VehicleOwnership backfill: % vehicle(s) without exactly one current owner', bad;
  END IF;
END $$;

-- WHO MAY TRANSFER: a permission of its own (decision 3 of the brief), given to the managers by default — the CRM
-- administrator, the workshop manager and the sales manager, in every workspace (the founding roles too, so a new
-- workspace's copies carry it). Owners pass every permission check already.
INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('vehicles.transfer', 'Transfer an accessible vehicle (and its warranty) to a new owner, and undo the last transfer', 'Workshop')
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category";

INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
SELECT r."id", 'vehicles.transfer', r."tenantId"
FROM "Role" r
WHERE split_part(r."id", ':', 1) IN ('role_crm_admin', 'role_workshop_manager', 'role_sales_manager')
ON CONFLICT DO NOTHING;
