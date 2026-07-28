-- Add a durable ownerUserId to Tenant so the provisioned owner is never inferred
-- from membership-table insert order (which is not stable across bulk imports and
-- member-removal cycles).  NULL until backfilled; set atomically in createTenant
-- going forward.

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT;

-- Backfill from the earliest TenantMember per tenant — the same heuristic that
-- was previously used at runtime, now made a one-time stable write so future
-- member additions/removals never change who the owner is.
UPDATE "Tenant" t
SET "ownerUserId" = (
  SELECT "userId"
  FROM "TenantMember"
  WHERE "tenantId" = t."id"
  ORDER BY "createdAt" ASC
  LIMIT 1
)
WHERE t."ownerUserId" IS NULL;

-- FK: SetNull on User delete so removing an owner row doesn't cascade-delete the
-- tenant.  Callers must handle ownerUserId IS NULL gracefully (activation blocked,
-- owner transfer required).
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId")
  REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Tenant_ownerUserId_idx" ON "Tenant"("ownerUserId");
