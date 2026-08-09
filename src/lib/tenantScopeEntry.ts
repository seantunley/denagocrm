import "server-only";
import { resolveActingTenant } from "./tenantContext";
import { honoredTenantClaim, decideStaffTenantScope } from "./tenant";
import { tenantEnforcing } from "./tenantEnforcement";
import { enterTenantScope, runInTenantScope } from "./tenantScope";
import { resolveChannelTenant, type ChannelKind } from "./channelTenant";
import { decideChannelScope, type ChannelResolution } from "./channelScopeDecision";

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
 * Establish the request's tenant SCOPE at an authenticated chokepoint (Phase C,
 * step 2). Seeds the AsyncLocalStorage scope the db.ts guard consumes.
 *
 * DORMANT: every function here returns immediately unless `tenantEnforcing()` is
 * true (always false today), so with enforcement off there is ZERO added work on
 * the hot path — no tenant resolution, no store mutation. When enforcement flips
 * on (per environment, step 5), these establish the scope so downstream DB access
 * is confined to the caller's tenant, and a request that can't resolve one fails
 * closed at the db layer.
 *
 * ONE DELIBERATE EXCEPTION: {@link withChannelTenantScope}. Its principal is an
 * inbound webhook authenticated by an install-GLOBAL secret that every tenant on
 * the same Meta app shares, so skipping resolution while dormant does not preserve
 * "the pre-tenancy path" — it silently files a second tenant's traffic under the
 * founding one. It therefore resolves in every mode, and falls back to the
 * unscoped path only when nothing resolves. See its own doc block.
 */

/**
 * Staff/app surface. Called from `getCurrentUser()` with the already-resolved user
 * id, the session's `tid` claim, and whether the principal is the GLOBAL `owner` —
 * resolves the user's sole active tenant and honours the claim exactly as
 * `getActiveTenantId()` does, but WITHOUT re-entering `getCurrentUser` (which would
 * recurse).
 *
 * Returns `{ ok }`. Under enforcement:
 *   - a valid acting tenant resolves → enter that tenant's scope, `ok:true`;
 *   - none resolves (tid absent/mismatched, membership removed, tenant suspended, or
 *     a second active membership made it ambiguous):
 *       · NON-OWNER → `ok:false` — the caller MUST fail the whole authentication, not
 *         just leave a null scope, so a stale/ambiguous session can't still pass
 *         `requireUser`/role/owner checks or trigger global side effects (unchanged);
 *       · OWNER → `ok:true` with NO scope established AT ALL (the OWNER ESCAPE HATCH —
 *         never a `system` scope). The global owner proceeds so the platform console
 *         (basePrisma reads) works, while every tenant-scoped CRM query still fails
 *         closed at the db guard for lack of a scope. The (app) layout redirects such
 *         an owner to the console to fix their tenancy.
 * When enforcement is off it always returns `{ ok: true }` (dormant — no rejection,
 * no scope, no DB read).
 */
export async function establishStaffTenantScope(
  userId: string,
  tid: string | null,
  isOwner: boolean,
): Promise<{ ok: boolean }> {
  if (!tenantEnforcing()) return { ok: true };
  const sole = await resolveActingTenant(userId);
  const tenantId = honoredTenantClaim(tid, sole);
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
 * Resolution runs in EVERY tenancy mode — the mode decides how a MISS is handled,
 * never whether we look. The webhook's only authentication is one install-global
 * `META_APP_SECRET` HMAC, which every tenant subscribed to the same Meta app
 * shares; if we skip the lookup while enforcement is off, a SECOND tenant's
 * inbound traffic runs unscoped and is filed under the founding tenant (its
 * conversations, contacts, leads and bot sessions), with replies going out from
 * the founding tenant's number. See ./channelScopeDecision for the full rule.
 *
 * ENFORCING: `fn` runs INSIDE the resolved tenant scope (reliable
 * `runInTenantScope`), so every downstream read/write/actor pick is confined to that
 * tenant; the scope reverts when `fn` returns. If the endpoint is unknown / disabled
 * / points at a suspended or deleted tenant, it runs `onUnresolved()` WITHOUT running
 * `fn` — an unmapped inbound event is skipped (fail closed), never processed against
 * the wrong tenant or unscoped. UNCHANGED by this fix.
 *
 * DORMANT when off: a RESOLVED endpoint is still scoped — that is the point. But an
 * unmapped one falls back to running `fn()` unscoped, exactly as before, because an
 * empty `ChannelIdentity` is the NORMAL state of an existing single-tenant install
 * (the map is populated by a manual pre-enforcement backfill). Failing closed here
 * would turn every inbound message into an error the moment this ships. A lookup that
 * THROWS degrades the same way, for the same reason: dormant ran no query at all
 * before, so a missing table or a database blip must not break a working webhook.
 */
export async function withChannelTenantScope<T>(
  channel: ChannelKind,
  externalId: string | null | undefined,
  fn: () => Promise<T>,
  onUnresolved: () => T | Promise<T>,
): Promise<T> {
  let resolution: ChannelResolution;
  let lookupError: unknown;
  try {
    const tenantId = await resolveChannelTenant(channel, externalId);
    resolution = tenantId ? { status: "resolved", tenantId } : { status: "unmapped" };
  } catch (error) {
    lookupError = error;
    resolution = { status: "failed" };
  }

  const decision = decideChannelScope(tenantEnforcing(), resolution);
  if (decision.run === "rethrow") throw lookupError;
  if (decision.run === "unresolved") return onUnresolved();
  if (decision.run === "unscoped") return fn();
  return runInTenantScope({ tenantId: decision.tenantId, system: false }, fn);
}
