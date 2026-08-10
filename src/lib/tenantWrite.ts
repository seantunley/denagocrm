import "server-only";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID, decideInheritedTenant } from "./tenant";
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
  if (!tenantEnforcing()) return { mode: "global" }; // dormant — unchanged behaviour
  const scope = currentTenantScope();
  if (!scope) return { mode: "closed" }; // enforcing but no scope established → fail closed
  if (scope.system) return { mode: "global" }; // deliberate trusted system bypass
  if (!scope.tenantId) return { mode: "closed" }; // enforcing + null non-system scope → fail closed
  return { mode: "tenant", tenantId: scope.tenantId };
}

/**
 * The tenantId to STAMP onto / FILTER a tenant-owned write with on an UNGUARDED
 * path — a `basePrisma` transaction (row locks, raw SQL) or a global model joined
 * by hand — where the db.ts guard does NOT auto-scope. Returns:
 *
 *   - a concrete tenantId under enforcement with a tenant scope (stamp + filter +
 *     namespace any advisory lock with it);
 *   - `null` when GLOBAL (dormant OR a trusted system scope) → the caller stamps
 *     nothing and applies no extra filter: byte-for-byte the pre-tenancy path;
 *   - THROWS {@link TenantScopeError} when CLOSED (enforcement on, no/again-null
 *     scope) so an unguarded write can never land tenantless, over-count another
 *     tenant's rows, or broadcast cross-tenant. Fail closed, exactly like the
 *     guarded client throwing on a scopeless query.
 */
export function writeTenantId(): string | null {
  const s = currentScopeClass();
  if (s.mode === "closed") {
    throw new TenantScopeError("No tenant scope established for a tenant-owned write");
  }
  return s.mode === "tenant" ? s.tenantId : null;
}

/**
 * The tenantId to STAMP a RUNTIME write with, where the tenant is inherited from
 * the record being acted on rather than from a session.
 *
 * `writeTenantId()` on its own is the wrong tool for a create and always has
 * been: it answers "how should an unguarded write behave during the enforcement
 * rollout", and it returns null while enforcement is DORMANT — which is today, in
 * every environment. Every writer that spread it (or `activeTenantPredicate()`,
 * or a hand-rolled mirror of `scopeArgs`) into a `create` has therefore been
 * writing `tenantId: null`: a row invisible at the flip to the very workspace
 * that produced it. The 2026-08-10 production audit counted 843 of them in a
 * fortnight.
 *
 * This is the create-side answer, and it never invents an owner — see
 * {@link ./tenant}.`decideInheritedTenant` for the ladder and why it is ordered
 * that way. `writeTenantId()` is still evaluated FIRST so its fail-closed throw
 * (enforcement on, no usable scope) happens before any fallback can paper over it.
 *
 * Pass the owner of the row this write descends from — `journey.tenantId`,
 * `run.tenantId`, `competitor.tenantId`, `lead.tenantId`. Pass `null` only when
 * there genuinely is no parent record.
 */
export function inheritedTenantId(recordTenantId?: string | null): string {
  const enforcedTenantId = writeTenantId();
  return decideInheritedTenant({
    enforcedTenantId,
    recordTenantId: recordTenantId ?? null,
    ambientTenantId: currentTenantScope()?.tenantId ?? null,
  });
}

/**
 * Run `fn` as ONE atomic transaction on the trusted bypass client (`basePrisma`),
 * handing it the transaction client and the owning tenantId. Use this to keep a
 * multi-write aggregate — a parent plus children the top-level guard would refuse
 * as a NESTED relation write — all-or-nothing: any throw rolls the whole thing back.
 *
 * The resolved tenantId is:
 *   - the current tenant under enforcement (see {@link writeTenantId});
 *   - `DEFAULT_TENANT_ID` when GLOBAL (enforcement off, or a trusted system scope),
 *     so a row is NEVER written tenantless during the pre-enforcement rollout window
 *     (a NULL-tenant row is invisible once enforcement flips on and fails the
 *     preflight). Throws (fail closed) when enforcing with no usable scope.
 *
 * Every write inside MUST stamp `tenantId` explicitly — bypass means the db.ts guard
 * will not do it for you, and the children share the parent's tenant so the
 * composite `(tenantId, parentId)` FKs hold.
 *
 * Keep this legacy callback contract broad for now: #400 needs a concrete
 * TenantWriteTx for its own new helpers, but globally tightening every existing
 * withTenantWrite caller belongs in a dedicated typing/refactor PR.
 */
export async function withTenantWrite<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (tx: any, tenantId: string) => Promise<T>,
): Promise<T> {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma as any).$transaction((tx: any) => fn(tx, tenantId));
}
