import "server-only";
import { resolveActingTenant } from "./tenantContext";
import { honoredTenantClaim, decideStaffTenantScope } from "./tenant";
import { tenantEnforcing } from "./tenantEnforcement";
import { enterTenantScope, runInTenantScope } from "./tenantScope";
import { resolveChannelTenant, type ChannelKind } from "./channelTenant";

/**
 * Run `fn` in a trusted `system` scope (`{ tenantId: null, system: true }`) — the
 * db.ts guard BYPASSES this scope by design, so cross-tenant/platform work reads
 * and writes every tenant's rows. For genuinely platform-global operations only:
 * whole-DB backup export, the security runbook, trash purge, errorLog cleanup.
 *
 * DORMANT: when enforcement is off this is a bare `fn()` with zero AsyncLocalStorage
 * overhead — byte-for-byte the pre-tenancy path. The scope is confined to `fn` and
 * reverts when it returns, so no system bypass lingers onto a later request.
 *
 * CONTRACT: `fn` must AWAIT its DB work internally. The scope covers only what is
 * awaited inside `fn`; returning a lazy Prisma thenable unawaited (`() => prisma.x
 * .findMany()`) lets the query execute AFTER the scope has reverted — so it fails
 * closed. Always `async () => { … await … }`.
 */
export function withSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  if (!tenantEnforcing()) return fn();
  return runInTenantScope({ tenantId: null, system: true }, fn);
}

/**
 * Run auth/session validation (which reads tenant-scoped infrastructure BEFORE the
 * principal's tenant is known — e.g. the webhook signature/verify-token settings)
 * in the trusted `system` scope. A named alias of {@link withSystemScope} for the
 * pre-principal auth boundary; same dormant-safe behaviour. The principal's own
 * tenant scope is established separately, after validation.
 */
export function validateInSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemScope(fn);
}

/**
 * Establish the request's tenant SCOPE at the authenticated staff chokepoint.
 *
 * This scope now exists in dormant mode too when the validated session resolves a
 * workspace. That does NOT turn the db.ts tenant guard on — `scopeArgs` still keeps
 * its documented dormant behaviour until TENANT_ENFORCEMENT=enforce. What it does
 * give us is a trustworthy ambient answer for the explicit `basePrisma` predicates
 * used by record-level authorization (`activeTenantPredicate`). Those predicates
 * are the boundary in front of bypass transactions, so letting the scope disappear
 * while dormant made `requireQuoteAccess`, `requireLeadAccess`, `requireJobCardAccess`
 * and their siblings authorize a foreign id before an otherwise unguarded write.
 *
 * In other words: dormant still means "do not globally switch the ORM guard on";
 * it no longer means "forget which workspace an authenticated person is acting in".
 */
export async function establishStaffTenantScope(
  userId: string,
  tid: string | null,
  isOwner: boolean,
): Promise<{ ok: boolean }> {
  // Resolve the exact same validated membership/claim pair in both modes. This is
  // the authenticated chokepoint, so unlike cron/webhook work there is a real
  // actor to ask. Background paths never call this function.
  const sole = await resolveActingTenant(userId);
  const tenantId = honoredTenantClaim(tid, sole);

  if (!tenantEnforcing()) {
    // Compatibility while the rollout is dormant: failure to resolve a workspace
    // does NOT reject a previously-valid session and does NOT invent a founding-
    // tenant owner. It simply leaves no scope, exactly as before. A successfully
    // resolved workspace, however, is bound so explicit basePrisma predicates can
    // enforce the real user-facing boundary today.
    if (tenantId) enterTenantScope({ tenantId, system: false });
    return { ok: true };
  }

  const decision = decideStaffTenantScope(true, tenantId, isOwner);
  // enterTenantId === null means enter NO scope — either the owner escape hatch or a
  // fail-closed miss; we NEVER enter a `system` scope for a user-facing request.
  if (decision.ok && decision.enterTenantId !== null) {
    enterTenantScope({ tenantId: decision.enterTenantId, system: false });
  }
  return { ok: decision.ok };
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

type TrustedTenantResolver = () => Promise<{ tenantId: string | null } | null>;

/**
 * Establish the tenant scope for a NO-USER token surface (public signing/approval
 * pages + their mutation routes, campaign tracking/unsubscribe) BEFORE any guarded
 * read, then run the work inside it. This is the portal pattern generalised: derive
 * the tenant from a narrow trusted lookup keyed by the public token, then execute
 * the guarded re-read + full operation inside `runInTenantScope`.
 *
 * DORMANT when off: skips the trusted lookup entirely and runs `fn()` directly —
 * byte-for-byte the pre-tenancy path, no ALS overhead, no extra query.
 *
 * ENFORCING: runs the narrow trusted `resolve()` (basePrisma, tenantId only). If it
 * can't resolve an owning tenant (unknown token / null tenant) it returns
 * `onFailClosed()` WITHOUT running `fn` — the guarded work never executes unscoped
 * or against the wrong tenant. Otherwise it runs `fn` INSIDE the resolved tenant
 * scope (RELIABLE `runInTenantScope`, never `enterWith` after a guarded bootstrap),
 * so the guarded re-read succeeds instead of dead-locking on a missing scope. The
 * scope reverts when `fn` returns, so nothing leaks to a later request.
 */
export async function withTokenTenantScope<T>(
  resolve: TrustedTenantResolver,
  fn: () => Promise<T>,
  onFailClosed: () => T | Promise<T>,
): Promise<T> {
  if (!tenantEnforcing()) return fn();
  const owner = await resolve();
  if (!owner || !owner.tenantId) return onFailClosed();
  return runInTenantScope({ tenantId: owner.tenantId, system: false }, fn);
}

/**
 * Establish the tenant scope for a NO-USER INBOUND CHANNEL event (WhatsApp / Meta
 * Messenger / Instagram webhook) BEFORE any guarded read, then run the per-event
 * work inside it. Same shape as {@link withTokenTenantScope}, keyed on the channel
 * discriminator (OUR endpoint id — phone-number id / Page id / IG id) instead of a
 * public token.
 *
 * The discriminator is PER-EVENT, not per-request: one webhook POST can carry events
 * for several of our endpoints, so this wraps the processing of a SINGLE event and
 * is called once per event inside the entry/change loop — each event runs in its own
 * resolved tenant scope.
 *
 * DORMANT when off: runs `fn()` directly — byte-for-byte the pre-tenancy path, no
 * channel lookup, no ALS overhead.
 *
 * ENFORCING: resolves the owning tenant via `resolveChannelTenant` (basePrisma,
 * active-tenant JOIN). If the endpoint is unknown / disabled / points at a suspended
 * or deleted tenant, it runs `onUnresolved()` WITHOUT running `fn` — an unmapped
 * inbound event is skipped (fail closed), never processed against the wrong tenant or
 * unscoped. Otherwise `fn` runs INSIDE the resolved tenant scope (reliable
 * `runInTenantScope`), so every downstream read/write/actor pick is confined to that
 * tenant; the scope reverts when `fn` returns.
 *
 * #489 changes this function on its own branch so resolved channel tenants bind in
 * dormant mode too. Keep that change when restacking: staff and channel chokepoints
 * solve the same ambient-scope problem for different principals.
 */
export async function withChannelTenantScope<T>(
  channel: ChannelKind,
  externalId: string | null | undefined,
  fn: () => Promise<T>,
  onUnresolved: () => T | Promise<T>,
): Promise<T> {
  if (!tenantEnforcing()) return fn();
  const tenantId = await resolveChannelTenant(channel, externalId);
  if (!tenantId) return onUnresolved();
  return runInTenantScope({ tenantId, system: false }, fn);
}
