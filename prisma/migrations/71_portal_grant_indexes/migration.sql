-- Restore the partial unique indexes on PortalAccessGrant that migration 50 was
-- meant to create but are missing on production (only the pkey + viewer_idx
-- exist), which made the portal-access upserts fail with 42P10
-- ("no unique or exclusion constraint matching the ON CONFLICT specification").
CREATE UNIQUE INDEX IF NOT EXISTS "PortalAccessGrant_contact_key"
  ON "PortalAccessGrant" ("viewerContactId", "grantedContactId")
  WHERE "grantedContactId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "PortalAccessGrant_fleet_key"
  ON "PortalAccessGrant" ("viewerContactId", "fleetId")
  WHERE "fleetId" IS NOT NULL;
