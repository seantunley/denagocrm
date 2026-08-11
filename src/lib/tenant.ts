/**
 * Tenant foundation helpers (multi-tenancy PR1). Deliberately PURE and
 * dependency-free — no `server-only`, no Prisma — so they can be unit-tested and
 * imported anywhere. The DB-backed accessor and request-context/session wiring
 * arrive in a later PR (see MULTITENANCY-SCOPING.md).
 */

/**
 * The founding tenant seeded for the existing Denago business by migration
 * 20260721130000_tenant_foundation. Use this ONLY to EXPLICITLY provision the
 * Denago tenant (migration + seed + single-tenant data import) — never as a
 * fallback to infer tenant access for a user who has no membership. Tenant access
 * is fail-closed: it comes from a real TenantMember row, not from this constant.
 */
export const DEFAULT_TENANT_ID = "tenant_denago_cpt";

export type SoleTenantResult =
  | { tenantId: string }
  | { error: "no_tenant" | "ambiguous_tenant" };

/**
 * Resolve the single tenant a user may act in WITHOUT an explicit session
 * selection, given the ids of the tenants where they hold an ACTIVE membership
 * (the caller must have already filtered out suspended tenants). This is
 * deliberately NOT "pick the active/earliest membership" — that conflated a
 * historical default with the working tenant and was nondeterministic on equal
 * timestamps. The rule:
 *   - 0 active tenants  → `no_tenant`        (provisioning required)
 *   - exactly 1         → that tenant
 *   - 2+ active tenants → `ambiguous_tenant` (needs an explicit selection; the
 *                          session-selected tenant lands in a later PR)
 * Order-independent, so equal `createdAt` timestamps can't change the outcome.
 */
export function soleActiveTenant(activeTenantIds: readonly string[]): SoleTenantResult {
  const unique = [...new Set(activeTenantIds)];
  if (unique.length === 0) return { error: "no_tenant" };
  if (unique.length > 1) return { error: "ambiguous_tenant" };
  return { tenantId: unique[0] };
}

/**
 * Decide whether a session's carried tenant claim (`tid`) may still be honoured,
 * given the user's freshly-resolved sole active tenant. The claim is honoured
 * ONLY when the user has exactly ONE active membership AND it equals the claim:
 *   - no tid                  → null (older / tenant-less session)
 *   - resolve error (0 or 2+) → null (`no_tenant`, or newly `ambiguous_tenant`
 *                                because a second active membership appeared
 *                                AFTER login — the claim is no longer unambiguous)
 *   - single active ≠ tid     → null (membership removed / tenant suspended)
 *   - single active === tid   → tid
 */
export function honoredTenantClaim(tid: string | null, sole: SoleTenantResult): string | null {
  if (!tid) return null;
  if ("error" in sole) return null;
  return sole.tenantId === tid ? tid : null;
}

/**
 * Decide which tenant a user's NEW login session is stamped with, given their
 * freshly-resolved acting tenant (`ctx`), their GLOBAL `role`, and whether
 * enforcement is on. PURE and dependency-free so it's unit-testable WITHOUT a DB.
 * Consumed by `createSessionCookie` right after `resolveActingTenant`.
 *
 *   - `ctx` resolved a tenant            → that tenant (the normal path).
 *   - error + ENFORCING + global `owner` → the founding tenant (DEFAULT_TENANT_ID):
 *     the owner falls back to their always-active home tenant rather than failing to
 *     get a session, so they can never be locked out. The caller ensures that
 *     membership is real (ensureFoundingMembership) under enforcement.
 *   - anything else                      → null.
 *
 * DORMANT: when `enforcing` is false this returns null on the error branch for EVERY
 * role (owner included), so login behaviour is byte-for-byte the pre-tenancy path.
 */
export function resolveLoginTenant(
  ctx: { tenantId: string } | { error: string },
  role: string,
  enforcing: boolean,
): string | null {
  if ("tenantId" in ctx) return ctx.tenantId;
  if (enforcing && role === "owner") return DEFAULT_TENANT_ID;
  return null;
}

/**
 * Outcome of the staff request-time tenant-scope decision. `enterTenantId === null`
 * means "establish NO scope at all" — critically NOT a `system` scope (there is no
 * system field here, by design, so this decision can never grant a bypass).
 */
export type StaffScopeDecision =
  | { ok: true; enterTenantId: string | null }
  | { ok: false; enterTenantId: null };

/**
 * Decide the staff chokepoint scope outcome from whether enforcement is on, the
 * already-honoured acting-tenant id (or null when none resolved), and whether the
 * principal is the GLOBAL `owner`. PURE so the branch is unit-testable without a DB
 * or `server-only`. Mirrors {@link establishStaffTenantScope}:
 *   - not enforcing            → ok, enter NO scope (dormant).
 *   - enforcing + a tenant     → ok, enter that tenant's scope.
 *   - enforcing + none + owner → ok, enter NO scope — the OWNER ESCAPE HATCH. The
 *                                owner is never a `system` principal; tenant-scoped
 *                                CRM reads still fail closed at the db guard, only
 *                                `basePrisma`-backed platform reads work.
 *   - enforcing + none + other → NOT ok (fail closed — unchanged for non-owners).
 */
export function decideStaffTenantScope(
  enforcing: boolean,
  tenantId: string | null,
  isOwner: boolean,
): StaffScopeDecision {
  if (!enforcing) return { ok: true, enterTenantId: null };
  if (tenantId) return { ok: true, enterTenantId: tenantId };
  if (isOwner) return { ok: true, enterTenantId: null }; // owner escape hatch: NO scope
  return { ok: false, enterTenantId: null };
}

/**
 * Which tenant a RUNTIME write is stamped with — a webhook, a cron tick, a
 * scheduled journey step, anything executing with no session to ask.
 *
 * The sibling of {@link ./flowTenantScope}.`decideBuilderTenant`, and deliberately
 * the same SHAPE: an ordered ladder ending at the founding tenant, so a row is
 * never written tenantless during the pre-enforcement window. Only the middle
 * rung differs, and that difference is the whole point — a builder request asks
 * the SESSION which workspace it is acting as; a runtime write has no session, so
 * it asks the RECORD IT IS ACTING ON. Neither ever invents an owner.
 *
 *   1. `enforcedTenantId` — `writeTenantId()`. Authoritative when enforcement is
 *      on (and it THROWS before reaching here when enforcement is on with no
 *      usable scope, so this ladder cannot be used to escape a fail-closed miss).
 *      Null while enforcement is dormant, which is today, which is why every
 *      writer that relied on it alone has been stamping NULL.
 *   2. `recordTenantId` — the owner of the row this write is derived from: the
 *      Journey being enrolled into, the JourneyRun whose step is being logged,
 *      the Competitor being researched, the Lead the note is about. A child that
 *      disagrees with its parent is worse than one that is merely unowned, so the
 *      parent decides.
 *   3. `ambientTenantId` — `currentTenantScope()?.tenantId`. The slice this cron
 *      tick is sweeping: `runCronPerTenant` binds a scope even on its dormant
 *      path, so this is a real answer today for a record that carries none.
 *   4. The founding tenant, which is byte-for-byte today's single-tenant
 *      behaviour and the same stand-in `runCronPerTenant` uses.
 *
 * PURE, so the ordering can be executed by a test rather than pattern-matched.
 * The ordering is the thing worth testing: swap rungs 1 and 2 and a legacy
 * NULL-tenant parent silently overrides the enforced scope; drop rung 2 and every
 * cron-written child collapses onto the founding tenant no matter whose record it
 * belongs to.
 */
export function decideInheritedTenant(input: {
  enforcedTenantId: string | null;
  recordTenantId?: string | null;
  ambientTenantId?: string | null;
}): string {
  return (
    input.enforcedTenantId ??
    input.recordTenantId ??
    input.ambientTenantId ??
    DEFAULT_TENANT_ID
  );
}

/**
 * True only when a Prisma write failed specifically because a `tenantId` foreign
 * key no longer resolves (the tenant was deleted concurrently) — the one case
 * recoverable by dropping the tenant and retrying. Duck-typed on the error's
 * `code`/`meta` so this module stays dependency-free and unit-testable. A null
 * tenant can't cause an FK error, so those cases return false and the caller must
 * rethrow the original error rather than mask an unrelated failure.
 */
export function isTenantForeignKeyViolation(error: unknown, tenantId: string | null): boolean {
  if (tenantId == null) return false;
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code !== "P2003") return false;
  const meta = (error as { meta?: unknown }).meta;
  return JSON.stringify(meta ?? {}).toLowerCase().includes("tenant");
}
