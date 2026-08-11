import "server-only";
import { getActiveTenantId } from "./auth";
import { basePrisma } from "./db";
import { decideActingScope, type ActingScope } from "./actingScopeRule";
import { DEFAULT_TENANT_ID } from "./tenant";
import { tenantEnforcing } from "./tenantEnforcement";
import { TenantScopeError } from "./tenantGuard";
import { currentScopeClass } from "./tenantWrite";

export type { ActingScope };

/**
 * The scope a USER-ORIGINATED operation acts in — the server shell around
 * {@link decideActingScope}.
 *
 * Use this for anything a signed-in person triggered: stamping a record they are
 * creating, validating an assignee they picked, listing the colleagues they may
 * pick from.
 *
 * Do NOT use it for background work. A cron, a webhook or a queue drain has no
 * session, so this resolves to `global` — the same answer `currentScopeClass()`
 * gives — and those paths should derive their tenant from the record they are
 * acting on (`inheritedTenantId`) rather than from an absent actor.
 */
/**
 * The workspace to STAMP on a record the acting person OWNS outright — one with no
 * parent to inherit from. Workspace configuration is the case that matters:
 * a support mailbox, a canned reply, a support tag. Those belong to the workspace
 * that created them, not to any record.
 *
 * Where a parent DOES exist, inherit from it instead. A note on a case belongs to
 * the case, not to the person typing it, so an admin acting in another workspace
 * cannot re-own it.
 *
 * Throws when the scope is `closed`, matching every other unguarded write.
 */
export async function actingOwnerTenantId(): Promise<string> {
  const scope = await actingScopeClass();
  if (scope.mode === "closed") {
    throw new TenantScopeError("No tenant scope established for a tenant-owned write");
  }
  return scope.mode === "tenant" ? scope.tenantId : DEFAULT_TENANT_ID;
}

export async function actingScopeClass(): Promise<ActingScope> {
  const enforcing = tenantEnforcing();
  // Skip the session lookup entirely when enforcing: the enforced scope is
  // authoritative and a session must never widen it.
  const sessionTenantId = enforcing ? null : await getActiveTenantId();
  return decideActingScope({
    enforcing,
    enforcedScope: currentScopeClass(),
    sessionTenantId,
  });
}

/**
 * `withTenantWrite` for a write a SIGNED-IN PERSON triggered.
 *
 * The difference is the owner, and it matters in exactly the window we are in now.
 * `withTenantWrite` resolves `writeTenantId() ?? DEFAULT_TENANT_ID`, and
 * `writeTenantId()` is null while enforcement is dormant — so it stamps the
 * FOUNDING tenant onto every actor's rows regardless of which workspace they are
 * working in. With one tenant that is invisible. With two it hands one workspace's
 * records to another, and it does so convincingly: the row looks correctly owned,
 * so nothing in an audit or a shape-based test flags it. The two-tenant harness
 * caught it as "Contact creation persists tenant_denago_cpt regardless of actor".
 *
 * This variant resolves the ACTING workspace instead — enforced scope, else the
 * validated session workspace, else the founding tenant. That last fallback is
 * reached only when there is no session at all, which for a user-originated write
 * means something upstream has already gone wrong.
 *
 * Background paths must keep `withTenantWrite`, or better, derive the owner from
 * the record being acted on. They have no session for this to resolve, and
 * inventing one is the same defect with the sign flipped.
 */
export async function withActingTenantWrite<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (tx: any, tenantId: string) => Promise<T>,
): Promise<T> {
  const scope = await actingScopeClass();
  if (scope.mode === "closed") {
    throw new TenantScopeError("No tenant scope established for a tenant-owned write");
  }
  const tenantId = scope.mode === "tenant" ? scope.tenantId : DEFAULT_TENANT_ID;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma as any).$transaction((tx: any) => fn(tx, tenantId));
}
