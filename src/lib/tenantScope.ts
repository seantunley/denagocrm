import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";

/**
 * Request-scoped tenant SCOPE (Phase C). Established once per request (auth layer
 * / route wrapper) or explicitly for background/public work, so any DB call —
 * however deep the stack — can discover which tenant it runs for without
 * threading it through every signature.
 *
 * (Distinct from lib/tenantContext.ts, which RESOLVES which tenant a user may act
 * in. This module just carries the resolved answer through the async call tree.)
 *
 * DORMANT until `tenantEnforcing()` returns true (see lib/tenantEnforcement.ts).
 * The db.ts guard only READS this store inside the enforcement branch, so with
 * enforcement off nothing here changes behaviour.
 *
 *   - tenantId: the single tenant this request may touch, or null when it can't
 *     be resolved (a null-tenant request is REFUSED under enforcement — never
 *     silently unscoped).
 *   - system: true for trusted cross-tenant work (backups, migrations, some
 *     cron) allowed to bypass scoping. Must be set explicitly and must never be
 *     reachable from a user-facing request path.
 */
export type TenantScope = {
  tenantId: string | null;
  system: boolean;
};

const storage = new AsyncLocalStorage<TenantScope>();

/**
 * THE SECOND CARRIER, and the one the Server Component render tree actually uses.
 *
 * On 2026-08-12 the enforcement flip took the CRM down: every page redirected to
 * /platform/login, and production logged `TenantScopeError: No tenant scope
 * established for Dashboard` on `GET /`. The mechanism is precise, and it is NOT
 * "enterWith is unreliable":
 *
 *   `getCurrentUser()` is wrapped in React `cache()`. The LAYOUT calls it first,
 *   the body runs, and `enterWith` binds the scope in the LAYOUT's async context.
 *   The PAGE then calls it and gets a CACHE HIT — the body never re-runs, so
 *   `enterWith` never fires in the page's context. The page then queries with no
 *   store, and the guard refuses it.
 *
 * Whether the page's context inherits the layout's is a property of how the React
 * server runtime schedules segments. It did in the dev server (measured, see
 * docs/enterwith-request-scope-finding.md) and it does not in the production
 * build — which is exactly the limit that document stated about itself and which
 * nobody had closed.
 *
 * `cache()` fixes this at the root because it is keyed to the REQUEST, not to an
 * async context: every segment of one render calling `requestScopeHolder()` gets
 * the SAME object, no matter which of them ran the auth body. So the scope no
 * longer has to propagate anywhere — it is simply read from a place both segments
 * can already see.
 *
 * ALS is KEPT, not replaced, and is still consulted FIRST — see below.
 */
type ScopeHolder = { scope: TenantScope | undefined };

const requestScopeHolder = cache((): ScopeHolder => ({ scope: undefined }));

/**
 * The holder, or null when there is no React request behind this call — a cron
 * tick, a queue drain, an operator script, a route handler outside a render.
 *
 * Guarded because `cache()` is only meaningful inside a Server Component render.
 * Outside one, React either throws or hands back a fresh object per call; BOTH
 * degrade to "no holder", which is correct rather than merely safe: those paths
 * establish their scope through `runInTenantScope`, which binds ALS for a real
 * async subtree and is unaffected by any of this.
 *
 * It can NEVER leak across requests. `cache()` is request-keyed inside a render,
 * and outside one there is nothing shared to leak — the object is created and
 * discarded within the call.
 */
function holder(): ScopeHolder | null {
  try {
    return requestScopeHolder();
  } catch {
    return null;
  }
}

/** Run `fn` with the given tenant scope bound for its whole async subtree. */
export function runInTenantScope<T>(
  scope: TenantScope,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(scope, fn);
}

/**
 * Establish the scope for the CURRENT async execution and everything downstream,
 * WITHOUT a callback wrapper. For chokepoints that resolve-then-return rather than
 * wrap a callback — e.g. `getCurrentUser()`, which resolves the user and returns
 * it, leaving the rest of the request to run outside any wrapper. Prefer
 * `runInTenantScope` wherever you control the enclosing callback.
 */
export function enterTenantScope(scope: TenantScope): void {
  storage.enterWith(scope);
  // ...and into the request-keyed holder, so a SIBLING segment that gets a
  // `cache()` HIT on the auth chokepoint — and therefore never executes the
  // `enterWith` above in its own async context — still finds the scope.
  const h = holder();
  if (h) h.scope = scope;
}

/**
 * The active tenant scope, or undefined if none was established.
 *
 * ALS IS CONSULTED FIRST, AND THE ORDER IS LOAD-BEARING. `runInTenantScope`
 * binds a scope for one async subtree and reverts on return — that is how
 * `withSystemScope` grants a trusted cross-tenant bypass, and how the public
 * signing/portal paths pin a tenant derived from a token. Those are deliberately
 * NARROWER and shorter-lived than the request's ambient scope, so they must win
 * while they are active and stop winning the moment they return. Reading the
 * holder first would let a request's ambient user scope override a system scope
 * nested inside it, silently turning a trusted cross-tenant read back into a
 * single-tenant one — and, worse, would make a reverted scope keep applying.
 *
 * `runInTenantScope` therefore deliberately does NOT write to the holder: a
 * temporary scope must leave no trace once its callback has returned.
 */
export function currentTenantScope(): TenantScope | undefined {
  const bound = storage.getStore();
  if (bound) return bound;
  return holder()?.scope;
}

/** Convenience: enter a normal (non-system) tenant scope. */
export function withTenant<T>(
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return runInTenantScope({ tenantId, system: false }, fn);
}

/** Convenience: enter a trusted cross-tenant (system) scope. */
export function withSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenantScope({ tenantId: null, system: true }, fn);
}
