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
 * Staff/app surface. Called from `getCurrentUser()` with the already-resolved user
 * id and the session's `tid` claim — resolves the user's sole active tenant and
 * honours the claim exactly as `getActiveTenantId()` does, but WITHOUT re-entering
 * `getCurrentUser` (which would recurse).
 *
 * Returns `{ ok }`. Under enforcement, `ok` is FALSE whenever no valid acting
 * tenant resolves (tid absent/mismatched, membership removed, tenant suspended, or
 * a second active membership made it ambiguous) — the caller MUST then fail the
 * whole authentication, not just leave a null scope, so a stale/ambiguous session
 * can't still pass `requireUser`/role/owner checks or trigger global side effects.
 * When enforcement is off it always returns `{ ok: true }` (dormant, no rejection).
 */
export async function establishStaffTenantScope(
  userId: string,
  tid: string | null,
): Promise<{ ok: boolean }> {
  if (!tenantEnforcing()) return { ok: true };
  const sole = await resolveActingTenant(userId);
  const tenantId = honoredTenantClaim(tid, sole);
  if (!tenantId) return { ok: false }; // fail closed at the chokepoint
  enterTenantScope({ tenantId, system: false });
  return { ok: true };
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
