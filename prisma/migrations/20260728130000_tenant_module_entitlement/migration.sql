-- Per-tenant module entitlement.
--
-- Modules were install-wide: a single AppSetting row keyed DISABLED_MODULES held
-- the disabled optional packs for the whole deployment. With more than one tenant
-- that is meaningless, so entitlement moves onto the tenant itself.
--
-- Semantics: "Tenant"."modules" is the set a tenant MAY use (CSV of module ids).
-- The tenant's own DISABLED_MODULES setting still applies on top, so the effective
-- set is (granted MINUS locally disabled). `core` is mandatory and never stored.
--
-- Default '' (core only) is FAIL-CLOSED for tenants created after this migration:
-- a new pack is never silently granted to a tenant nobody deliberately granted it
-- to. The founding tenant is exempted below to preserve current behaviour exactly.

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "modules" TEXT NOT NULL DEFAULT '';

-- Backfill the FOUNDING tenant with the packs the install currently has enabled,
-- so nothing appears or disappears in the live CRM on deploy.
--
-- The old setting stores what is DISABLED, so the grant is every optional module
-- MINUS that list. The optional list is hardcoded here on purpose: a migration
-- must be reproducible, and reading it from application code would let a future
-- registry change silently rewrite history on replay.
--
-- Optional packs at the time of writing:
--   inbox, support, marketing, automation, automotive, commerce, portal
DO $$
DECLARE
  optional_modules TEXT[] := ARRAY[
    'inbox', 'support', 'marketing', 'automation', 'automotive', 'commerce', 'portal'
  ];
  disabled_csv TEXT;
  disabled_list TEXT[];
  granted TEXT;
BEGIN
  -- Only meaningful if the founding tenant actually exists (fresh installs may
  -- run this before any tenant row is seeded).
  IF NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt') THEN
    RETURN;
  END IF;

  -- Scope the read to the FOUNDING tenant explicitly. AppSetting carries a
  -- tenantId column, and once per-tenant settings land there can be several rows
  -- for this key — an unscoped "LIMIT 1" would then pick an arbitrary tenant's
  -- preferences and backfill Denago CPT with them. NULL tenantId is accepted too,
  -- since pre-backfill rows predate the column being populated.
  SELECT "value" INTO disabled_csv
  FROM "AppSetting"
  WHERE "key" = 'DISABLED_MODULES'
    AND ("tenantId" = 'tenant_denago_cpt' OR "tenantId" IS NULL)
  ORDER BY ("tenantId" IS NULL)  -- prefer the tenant-scoped row when both exist
  LIMIT 1;

  IF disabled_csv IS NULL OR btrim(disabled_csv) = '' THEN
    -- Nothing disabled (or never configured) => every optional pack was on.
    disabled_list := ARRAY[]::TEXT[];
  ELSE
    SELECT array_agg(btrim(part))
      INTO disabled_list
      FROM unnest(string_to_array(disabled_csv, ',')) AS part
     WHERE btrim(part) <> '';
    IF disabled_list IS NULL THEN
      disabled_list := ARRAY[]::TEXT[];
    END IF;
  END IF;

  SELECT string_agg(m, ',' ORDER BY m)
    INTO granted
    FROM unnest(optional_modules) AS m
   WHERE NOT (m = ANY(disabled_list));

  UPDATE "Tenant"
     SET "modules" = COALESCE(granted, '')
   WHERE "id" = 'tenant_denago_cpt';
END $$;
