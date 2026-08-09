import "server-only";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { TenantScopeError } from "./tenantGuard";

/** Transaction client for new helpers that want an explicit Prisma transaction type. */
export type TenantWriteTx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];

/**
 * How a tenant-owned read/write on an UNGUARDED path should behave for the CURRENT
 * scope. This is the single source of truth for the global/tenant/closed decision —
 * the same classification the actor resolvers use ({@link ./tenantActor}) and the
 * db.ts guard makes inline. Deliberately does NOT collapse "run globally" and "fail
 * closed" into one null: under enforcement a missing scope, or a null non-system
 * scope, must FAIL CLOSED, not silently fall back to every tenant's rows.
 *
 *  - `global`  — dormant (enforcement off) OR an explicit trusted `system` scope.
 *  - `tenant`  — enforcement on with a concrete tenant scope.
 *  - `closed`  — enforcement on with NO scope, or a `{ tenantId: null, system:false }`
 *                scope: a missed chokepoint / lost propagation → touch NOTHING.
 */
export type ScopeClass =
  | { mode: "global" }
  | { mode: "tenant"; tenantId: string }
  | { mode: "closed" };

export function currentScopeClass(): ScopeClass {
  if (!tenantEnforcing()) return { mode: "global" };
  const scope = currentTenantScope();
  if (!scope) return { mode: "closed" };
  if (scope.system) return { mode: "global" };
  if (!scope.tenantId) return { mode: "closed" };
  return { mode: "tenant", tenantId: scope.tenantId };
}

export function writeTenantId(): string | null {
  const s = currentScopeClass();
  if (s.mode === "closed") throw new TenantScopeError("No tenant scope established for a tenant-owned write");
  return s.mode === "tenant" ? s.tenantId : null;
}

export async function withTenantWrite<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (tx: any, tenantId: string) => Promise<T>,
): Promise<T> {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma as any).$transaction((tx: any) => fn(tx, tenantId));
}
