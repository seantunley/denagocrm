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
 * RESOLVED — IN EITHER MODE: `fn` runs INSIDE the resolved tenant scope (reliable
 * `runInTenantScope`, never `enterWith`), so every downstream read/write/actor pick
 * can name that tenant; the scope reverts when `fn` returns.
 *
 * IT BINDS WHILE ENFORCEMENT IS DORMANT TOO, AND THAT IS THE POINT. This used to be
 * `if (!tenantEnforcing()) return fn();` — it resolved nothing and bound nothing in
 * the only mode any environment actually runs in. So the whole bot runtime fell back
 * to `writeTenantId() ?? DEFAULT_TENANT_ID` and claimed every tenant's inbound events
 * under the FOUNDING tenant. `BotInboundEvent` deduplicates on
 * `("tenantId","channel","providerId")`, so two tenants whose customers produce the
 * same provider id collided and the second tenant's message was silently acked as a
 * redelivery of the first tenant's — a lost customer message with no error anywhere.
 * `withTelegramTenantScope` has always bound regardless of enforcement, and
 * `runCronPerTenant` binds on its dormant path for the same reason: a queue that
 * works in one mode and is broken in the other is not working.
 *
 * Binding is safe because the db.ts guard only READS the scope inside its enforcement
 * branch (`scopeArgs` returns its args untouched while dormant), so no query is
 * narrowed by this. What DOES change is that the helpers which consult the ambient
 * scope in BOTH modes — `inheritedTenantId`'s ambient rung, and therefore
 * `botConversationTenantId`; the per-tenant credential lookups in whatsapp.ts /
 * messenger.ts; `activeTenantPredicate` in the receipt path — now get the endpoint's
 * real owner instead of nothing. That is the intent: a receipt for tenant B stops
 * being applied across every tenant's messages, and B's replies go out over B's own
 * provider credentials rather than whoever's are configured globally.
 *
 * UNRESOLVED — unknown endpoint, `disabledAt` set, suspended or deleted tenant:
 *
 *   - ENFORCING → `onUnresolved()` WITHOUT running `fn`, unchanged. An unmapped
 *     inbound event is skipped rather than processed against the wrong tenant.
 *   - DORMANT → `fn()` with NO scope, which is byte-for-byte what this whole helper
 *     did before. This is deliberate and it is the one place the two modes differ.
 *     `ChannelIdentity` is enforcement-prep data that no environment is required to
 *     have backfilled yet, so failing closed on it while dormant would silently drop
 *     live customer traffic on every install whose endpoints are not mapped — and
 *     losing messages is the defect being fixed here, not an acceptable cost of
 *     fixing it. An install with no mappings therefore behaves exactly as it does
 *     today, and starts being scoped the moment its endpoints are mapped.
 *
 * The lookup itself is one indexed row on `basePrisma`, and it is now paid on the
 * dormant path as well — the deliberate cost of the scope existing at all.
 */
export async function withChannelTenantScope<T>(
  channel: ChannelKind,
  externalId: string | null | undefined,
  fn: () => Promise<T>,
  onUnresolved: () => T | Promise<T>,
): Promise<T> {
  const tenantId = await resolveChannelTenant(channel, externalId);
  if (tenantId) return runInTenantScope({ tenantId, system: false }, fn);
  return tenantEnforcing() ? onUnresolved() : fn();
}
