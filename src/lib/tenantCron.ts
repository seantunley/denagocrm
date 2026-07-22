import "server-only";
import { basePrisma } from "./db";
import { tenantEnforcing } from "./tenantEnforcement";
import { runInTenantScope } from "./tenantScope";

/**
 * Cron scoping (Phase C, step 2b-C4). Background jobs run with NO logged-in staff
 * user, so under enforcement they resolve no tenant and every guarded query fails
 * closed. Platform-global sweeps (backup, security) use `withSystemScope`; the
 * per-TENANT business queues (journeys, automations, competitor-watch, campaign /
 * survey / lifecycle) use the loop below.
 *
 * The per-tenant branch is DEAD CODE until enforcement flips — scaffolded here,
 * exercised in the enforcement PR.
 */

/**
 * The active tenants a per-tenant cron must sweep. RAW SQL through `basePrisma`
 * because it runs BEFORE any scope exists (and `Tenant` is a global model anyway);
 * a suspended/deleted tenant is excluded, so its queues stop running.
 */
export async function activeTenantIds(): Promise<string[]> {
  const rows = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "active" = true ORDER BY "createdAt" ASC`;
  return rows.map((r) => r.id);
}

export type CronRun<T> = { tenantId: string | null; result: T };

/**
 * Run one cron `slice` with the correct tenant scope.
 *
 * DORMANT (enforcement off): runs the slice ONCE, unscoped, with `tenantId = null`
 * — byte-for-byte the existing global sweep (no tenant lookup, no AsyncLocalStorage,
 * no per-tenant fan-out). Returns a single run.
 *
 * ENFORCING: runs the slice once per ACTIVE tenant, each inside that tenant's scope
 * (`runInTenantScope`), so every guarded query and `resolveTenantActor` pick inside
 * is confined to the tenant. Slices run sequentially (crons are already time-boxed
 * and rate-limited per host); one tenant's slice cannot see or mutate another's.
 * Returns one run per tenant.
 *
 * Callers preserve the pre-tenancy response shape by unwrapping the single dormant
 * run (`runs[0].result`) and only emitting the per-tenant array under enforcement.
 */
export async function runCronPerTenant<T>(
  slice: (tenantId: string | null) => Promise<T>,
): Promise<Array<CronRun<T>>> {
  if (!tenantEnforcing()) {
    return [{ tenantId: null, result: await slice(null) }];
  }
  const runs: Array<CronRun<T>> = [];
  for (const tenantId of await activeTenantIds()) {
    runs.push({
      tenantId,
      result: await runInTenantScope({ tenantId, system: false }, () => slice(tenantId)),
    });
  }
  return runs;
}
