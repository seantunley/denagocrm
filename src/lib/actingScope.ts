import "server-only";
import { getActiveTenantIdIfRequest, getCurrentUser } from "./auth";
import { basePrisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { decideActingScope, type ActingScope } from "./actingScopeRule";
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
  const sessionTenantId = enforcing ? null : await getActiveTenantIdIfRequest();
  let enforcedScope = currentScopeClass();

  // ESTABLISH THE SCOPE HERE IF NOBODY ELSE DID, RATHER THAN REFUSING.
  //
  // Under enforcement this function reads the ambient scope and NOTHING else, so
  // it is only correct if some caller upstream established that scope in THIS
  // execution context. On 2026-08-13 that assumption failed twice on the same
  // click — "Research" on a contact — with:
  //
  //     TenantScopeError: contact access check: this request has no resolvable
  //     workspace.                              context: POST /contacts/<id>
  //
  // #517 made `getCurrentUser()` re-enter the scope on every call instead of once
  // inside its memoised body. That was a real defect and the fix stands, but it
  // did not fix this, for a reason I should have checked before shipping it:
  // THIS PATH NEVER CALLS `getCurrentUser()`. `canAccessContact(user, id)` is
  // handed its `user` as an argument, so nothing in its execution context ever
  // re-enters anything, and `enterWith` from a sibling branch is not visible here.
  //
  // Chasing "which caller forgot" is the loop we have been in since the flip:
  // layout vs page, action vs re-render, and now a helper that takes the user as a
  // parameter. Each fix repaired one caller and left the next one to find in
  // production. So resolve it at the point of USE.
  //
  // `getCurrentUser()` is `cache()`d — no extra query on a request that already
  // called it — and post-#517 it re-enters the scope in OUR context. If it
  // resolves nothing (no session at all, a genuinely tenantless owner) the scope
  // stays absent and `decideActingScope` refuses exactly as before.
  //
  // THIS DOES NOT WIDEN ANYTHING, and that distinction is the whole safety
  // argument. It runs only when there is NO scope; an existing scope — including a
  // narrower one, and including `system` — is left untouched and still wins. The
  // value it recovers comes from `establishStaffTenantScope`, the same chokepoint
  // that would have set it, from the same validated session. It re-derives what
  // was lost; it never overrides what is present.
  //
  // `closed`, NOT `global`. Under enforcement `currentScopeClass()` answers
  // `closed` for "no scope established" and reserves `global` for a DELIBERATE
  // system bypass (`scope.system === true`). Keying this on `global` — which is
  // what I wrote first — would have done exactly the wrong thing twice over: never
  // fired on the failure this exists for, and replaced a trusted cross-tenant
  // scope with the acting user's tenant on backups, trash and audit.
  if (enforcing && enforcedScope.mode === "closed") {
    await getCurrentUser().catch(() => null);
    enforcedScope = currentScopeClass();
  }

  return decideActingScope({
    enforcing,
    enforcedScope,
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
 * Throws for ANYTHING that is not a resolved workspace — `closed` and `global`
 * alike. There is no founding-tenant fallback any more.
 *
 * WHY THE FALLBACK HAD TO GO. This returned DEFAULT_TENANT_ID for `global`, on
 * the reasoning that `global` means a background path with no session. It does
 * not only mean that: `actingScopeClass()` answers `global` whenever a SESSION
 * cannot be resolved to one workspace — a claim minted before `tid` existed, one
 * gone stale after a membership changed, or one that is AMBIGUOUS because the
 * person holds two or more active memberships.
 *
 * So a signed-in person in any of those states created a record and it was
 * stamped with the FOUNDING tenant. That is the failure this codebase's own
 * actingTenant.ts calls out as the worse direction, and it is exactly right: an
 * unowned row is visibly unfinished and can be backfilled, while a row stamped
 * with a confident, wrong owner reads as correct to every later query, appears
 * in the wrong workspace, and nothing ever flags it.
 *
 * Harmless while one workspace existed, because the guess was always right.
 * Not harmless with two.
 */
export async function actingOwnerTenantId(): Promise<string> {
  const scope = await actingScopeClass();
  if (scope.mode !== "tenant") {
    throw new TenantScopeError(
      "No workspace is attached to this sign-in, so there is nobody to own this record. " +
        "Sign out and back in; if you belong to more than one workspace, sign in to the one you mean to work in.",
    );
  }
  return scope.tenantId;
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
 * RESOLUTION FAILURE IS NOT CAUGHT. This used to end
 * `.catch(() => DEFAULT_TENANT_ID)`, on the reasoning that `getActiveTenantId()`
 * reads cookies and throws where there is no request at all, and those callers
 * legitimately have no session.
 *
 * That swallowed the refusal `actingTenantId()` exists to make, and did it on a
 * path that is explicitly user-originated: `pauseBotConversation` and
 * `resumeBotConversation` are Server Actions a signed-in person triggers, and
 * `enqueueStaffReply` binds through here before writing the pause, the outbox
 * row and the reply decision. So a stale or ambiguous staff session was turned
 * into the FOUNDING tenant, and in the outbox path that tenant chooses the
 * BotSession/outbox partition and the ambient provider context — one workspace's
 * action executed under another's, which is the whole thing this change exists
 * to stop.
 *
 * The sessionless callers the catch was defending are already handled by the
 * line above: work that arrives properly scoped — a webhook, a cron slice, a
 * channel drain — returns early and never reaches the resolver. What is left is
 * a caller with no ambient scope AND no resolvable session, and there is no
 * correct workspace to invent for it.
 */
export async function withStaffConversationScope<T>(fn: () => Promise<T>): Promise<T> {
  if (currentTenantScope()) return fn();
  const tenantId = await actingTenantId();
  return runInTenantScope({ tenantId, system: false }, fn);
}

export async function withActingTenantWrite<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (tx: any, tenantId: string) => Promise<T>,
): Promise<T> {
  const scope = await actingScopeClass();
  // Same rule as actingOwnerTenantId, and for the same reason: this hands the
  // callback a tenantId that every row created inside the transaction is stamped
  // with, so a founding-tenant fallback here files a whole operation — parent
  // and children together — under the wrong workspace.
  if (scope.mode !== "tenant") {
    throw new TenantScopeError(
      "No workspace is attached to this sign-in, so there is nobody to own this record. " +
        "Sign out and back in; if you belong to more than one workspace, sign in to the one you mean to work in.",
    );
  }
  const tenantId = scope.tenantId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma as any).$transaction((tx: any) => fn(tx, tenantId));
}
