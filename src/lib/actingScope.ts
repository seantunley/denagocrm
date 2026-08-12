import "server-only";
import { getActiveTenantId } from "./auth";
import { basePrisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { decideActingScope, type ActingScope } from "./actingScopeRule";
import { DEFAULT_TENANT_ID } from "./tenant";
import { tenantEnforcing } from "./tenantEnforcement";
import { TenantScopeError } from "./tenantGuard";
import { currentTenantScope, runInTenantScope } from "./tenantScope";
import { currentScopeClass } from "./tenantWrite";

export type { ActingScope };

/**
 * `getActiveTenantId()` is a request helper: outside a live Next request its
 * `cookies()` call deliberately throws. That is the correct signal for cron,
 * scripts and integration tests — there simply is no session whose workspace
 * could narrow the operation — so those callers remain `global`, exactly as the
 * acting-scope contract says background work should.
 *
 * Catch ONLY Next's documented missing-request error. Any real failure while a
 * request exists (DB/session resolution, malformed state, etc.) still propagates;
 * silently converting those failures to `global` would widen access at the exact
 * moment the tenant decision became uncertain.
 */
async function dormantSessionTenantId(): Promise<string | null> {
  try {
    return await getActiveTenantId();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("next-dynamic-api-wrong-context") ||
        error.message.includes("outside a request scope"))
    ) {
      return null;
    }
    throw error;
  }
}

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
export async function actingScopeClass(): Promise<ActingScope> {
  const enforcing = tenantEnforcing();
  // Skip the session lookup entirely when enforcing: the enforced scope is
  // authoritative and a session must never widen it.
  const sessionTenantId = enforcing ? null : await dormantSessionTenantId();
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

/**
 * Bind the ACTING workspace as an ambient scope for one staff operation, so that
 * everything inside it resolves the same workspace — once, not per call.
 *
 * The mirror of `withChannelTenantScope` on the other side of a bot conversation.
 * The webhook binds the workspace that owns the provider ENDPOINT; this binds the
 * workspace the person is signed into. Both halves then read the same ambient rung
 * (see {@link ../botTenant}.`botConversationTenantId`), which is the only way the
 * queue writer, its idempotency re-read, the takeover and the drain can be moved
 * together instead of one at a time — the entanglement #473 stopped at.
 *
 * NEVER WIDENS OR REPLACES AN EXISTING SCOPE. If one is already bound — under
 * enforcement, inside a webhook, inside a cron slice — that scope is authoritative
 * and this is a bare `fn()`. A session must not be able to redirect work that was
 * already scoped by something that outranks it.
 *
 * Resolution failure falls back to the founding tenant rather than throwing:
 * `getActiveTenantId()` reads cookies and the session registry, which throw where
 * there is no request at all, and those callers legitimately have no session. The
 * founding tenant is what they resolved before this existed.
 */
export async function withStaffConversationScope<T>(fn: () => Promise<T>): Promise<T> {
  if (currentTenantScope()) return fn();
  const tenantId = await actingTenantId().catch(() => DEFAULT_TENANT_ID);
  return runInTenantScope({ tenantId, system: false }, fn);
}

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
