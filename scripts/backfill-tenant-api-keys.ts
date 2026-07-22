/**
 * Backfill: register the current global INTAKE_API_KEY as the home tenant's
 * per-tenant API key, so the existing website embed keeps working AND resolves to a
 * tenant once enforcement is on.
 *
 * NOT run on deploy and NOT required for dormant operation — the routes still accept
 * the legacy global key via the back-compat path while `tenantEnforcing()` is false.
 * This is ENFORCEMENT-PREP: run it (against prod, backup-first) before flipping
 * enforcement, alongside the other prerequisites. Idempotent — safe to re-run.
 *
 *   tsx --tsconfig tsconfig.scripts.json scripts/backfill-tenant-api-keys.ts
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { hashApiKey } from "../src/lib/apiKeys";

async function main() {
  const setting = await basePrisma.$queryRaw<{ value: string }[]>`
    SELECT "value" FROM "AppSetting" WHERE "key" = 'INTAKE_API_KEY' LIMIT 1`;
  const rawKey = setting[0]?.value;
  if (!rawKey) {
    console.log("No INTAKE_API_KEY configured — nothing to backfill.");
    return;
  }

  // Home tenant = the single active tenant. If there is more than one, refuse and
  // require an explicit choice (a second dealer should register their own key).
  const tenants = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "active" = true`;
  if (tenants.length !== 1) {
    throw new Error(`Expected exactly one active tenant, found ${tenants.length}. Register per-tenant keys explicitly instead.`);
  }
  const tenantId = tenants[0].id;

  const hashedKey = hashApiKey(rawKey);
  const existing = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TenantApiKey" WHERE "hashedKey" = ${hashedKey} LIMIT 1`;
  if (existing[0]) {
    console.log("The global key is already registered — nothing to do.");
    return;
  }

  const id = crypto.randomUUID();
  await basePrisma.$executeRaw`
    INSERT INTO "TenantApiKey" ("id", "tenantId", "label", "hashedKey", "prefix", "scopes", "createdAt")
    VALUES (${id}, ${tenantId}, ${"Legacy global INTAKE_API_KEY"}, ${hashedKey}, ${rawKey.slice(0, 8)}, ${"intake,bookings,service-lookup"}, CURRENT_TIMESTAMP)`;
  console.log(`Registered the legacy global INTAKE_API_KEY for tenant ${tenantId} (key id ${id}).`);
}

main()
  .then(() => basePrisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
