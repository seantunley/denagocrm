import "server-only";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { TenantScopeError } from "./tenantGuard";

/** Transaction client for new helpers that want an explicit Prisma transaction type. */
export type TenantWriteTx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];

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
  if (s.mode === "closed") {
    throw new TenantScopeError("No tenant scope established for a tenant-owned write");
  }
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
