import { AsyncLocalStorage } from "node:async_hooks";

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
}

/** The active tenant scope, or undefined if none was established. */
export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore();
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
