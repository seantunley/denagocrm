import "server-only";
import { resolveActingTenant } from "./tenantContext";
import { honoredTenantClaim } from "./tenant";
import { tenantEnforcing } from "./tenantEnforcement";
import { enterTenantScope, runInTenantScope } from "./tenantScope";

/**
 * Run auth/session validation (which reads tenant-scoped infrastructure BEFORE
 * the principal's tenant is known) in a trusted `system` scope — but ONLY when
 * enforcement is on. When off this is a bare `fn()` call with zero AsyncLocalStorage
 * overhead, so the auth hot path is unchanged from pre-tenancy. The scope is
 * confined to `fn`, so it reverts when `fn` returns (no lingering system bypass on
 * the unauthenticated path); the principal's own scope is established separately.
 */
export function validateInSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  if (!tenantEnforcing()) return fn();
  return runInTenantScope({ tenantId: null, system: true }, fn);
}

/**
 * Establish the request's tenant SCOPE at an authenticated chokepoint (Phase C,
 * step 2). Seeds the AsyncLocalStorage scope the db.ts guard consumes.
 *
 * DORMANT: every function here returns immediately unless `tenantEnforcing()` is
 * true (always false today), so with enforcement off there is ZERO added work on
 * the hot path — no tenant resolution, no store mutation. When enforcement flips
 * on (per environment, step 5), these establish the scope so downstream DB access
 * is confined to the caller's tenant, and a request that can't resolve one fails
 * closed at the db layer.
 */

/**
 * Staff/app surface. Called from `getCurrentUser()` with the already-resolved
 * user id and the session's `tid` claim — resolves the user's sole active tenant
 * and honours the claim exactly as `getActiveTenantId()` does, but WITHOUT
 * re-entering `getCurrentUser` (which would recurse). No-op when enforcement off.
 */
export async function establishStaffTenantScope(
  userId: string,
  tid: string | null,
): Promise<void> {
  if (!tenantEnforcing()) return;
  const sole = await resolveActingTenant(userId);
  enterTenantScope({ tenantId: honoredTenantClaim(tid, sole), system: false });
}

/**
 * Any chokepoint that has already resolved the owning tenant of the principal
 * (e.g. the customer portal, from its Contact's `tenantId`). No-op when
 * enforcement off. A null tenantId is carried through — under enforcement the db
 * guard refuses it (fail closed), never runs unscoped.
 */
export function establishTenantScopeFromId(tenantId: string | null): void {
  if (!tenantEnforcing()) return;
  enterTenantScope({ tenantId, system: false });
}
