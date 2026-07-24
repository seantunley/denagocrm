-- Existing Journey records pre-date tenant ownership. Assign the legacy global
-- Journey estate to the founding Denago tenant before the tenant guard scopes it.
-- Replay-safe: every update is restricted to rows that still have no tenant.

UPDATE "Journey"
SET "tenantId" = 'tenant_denago_cpt'
WHERE "tenantId" IS NULL;

UPDATE "JourneyVersion" v
SET "tenantId" = j."tenantId"
FROM "Journey" j
WHERE v."journeyId" = j."id" AND v."tenantId" IS NULL;

UPDATE "JourneyEvent" e
SET "tenantId" = COALESCE(j."tenantId", 'tenant_denago_cpt')
FROM "Journey" j
WHERE e."journeyId" = j."id" AND e."tenantId" IS NULL;

-- Events not pinned to one Journey were historically global. They belong to the
-- same founding tenant as the pre-multi-tenant CRM data.
UPDATE "JourneyEvent"
SET "tenantId" = 'tenant_denago_cpt'
WHERE "tenantId" IS NULL;

UPDATE "JourneyRun" r
SET "tenantId" = j."tenantId"
FROM "Journey" j
WHERE r."journeyId" = j."id" AND r."tenantId" IS NULL;

UPDATE "JourneyStepLog" l
SET "tenantId" = r."tenantId"
FROM "JourneyRun" r
WHERE l."runId" = r."id" AND l."tenantId" IS NULL;
