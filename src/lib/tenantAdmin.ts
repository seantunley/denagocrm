import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * PURE, dependency-free decision helpers for the platform-admin tenant console.
 * No Prisma, no `server-only`, no env reads — every branch is a plain function of
 * its arguments so the guard logic is unit-testable WITHOUT a database. The server
 * actions in `app/actions/tenants.ts` and the platform page compose these; the
 * effectful bits (DB reads, audit, revalidate) stay in the action layer.
 */

export type GuardResult = { ok: true } | { ok: false; error: string };

const OK: GuardResult = { ok: true };

/**
 * Platform super-admin gate. The tenant console is a GLOBAL surface (it can stand
 * up brand-new tenants), so it is confined to the global `owner` role — the same
 * role that grants every permission elsewhere. Anyone else is refused.
 */
export function isPlatformAdmin(role: string | null | undefined): boolean {
  return role === "owner";
}

/** Guard form of {@link isPlatformAdmin}, for actions that surface a message. */
export function ensurePlatformAdmin(role: string | null | undefined): GuardResult {
  return isPlatformAdmin(role)
    ? OK
    : { ok: false, error: "Only platform owners can manage tenants." };
}

/**
 * SAFETY GATE for activation. A tenant created here is deliberately INERT until
 * data-isolation enforcement is live (see provisioning.createTenant). Activating a
 * second tenant while `tenantEnforcing()` is false would let that tenant's owner
 * sign into the still-unscoped CRM and see EXISTING data, so activation is refused
 * until enforcement is on. Callers pass `tenantEnforcing()`.
 */
export function canActivateTenant(enforcing: boolean): GuardResult {
  return enforcing
    ? OK
    : {
        ok: false,
        error:
          "Tenant isolation enforcement must be enabled before activating additional tenants — activating now would expose existing data.",
      };
}

/**
 * The founding Denago tenant underpins every existing user and session; suspending
 * it (active:false) would fail-closed lock the whole business out. Never allowed.
 */
export function canSuspendTenant(
  tenantId: string,
  foundingTenantId: string = DEFAULT_TENANT_ID,
): GuardResult {
  return tenantId === foundingTenantId
    ? { ok: false, error: "The founding tenant cannot be suspended." }
    : OK;
}

/**
 * A tenant must always retain at least one member — an ownerless tenant is
 * unreachable and unrecoverable. Refuse removing the final membership.
 * `currentMemberCount` is the tenant's member count BEFORE the removal.
 */
export function canRemoveTenantMember(currentMemberCount: number): GuardResult {
  return currentMemberCount <= 1
    ? { ok: false, error: "A tenant must keep at least one member." }
    : OK;
}

/**
 * LOCKOUT GUARD. Authentication resolves a user's acting tenant with
 * `soleActiveTenant`, which requires EXACTLY ONE active membership: zero gives
 * `no_tenant`, two or more give `ambiguous_tenant`. Both resolve to no honoured
 * tenant claim, and under enforcement that makes `getCurrentUser` return null —
 * the user cannot sign in at all.
 *
 * So granting a second membership does not "add access", it DESTROYS the user's
 * access. Refuse it until an explicit tenant-switching model exists.
 *
 * `tenantIdsForUser` must be EVERY membership the user holds, not merely those in
 * ACTIVE tenants: a membership in an inactive tenant looks harmless today and
 * becomes ambiguous the moment that tenant is activated.
 *
 * This is a friendly pre-check for a good error message, NOT the boundary. Two
 * concurrent additions could both pass it, so the authoritative guarantee is the
 * unique index on `TenantMember.userId` (migration
 * 20260727120000_tenant_member_single_tenant_policy); callers must still handle
 * its violation.
 */
export function canAddTenantMember(
  tenantIdsForUser: readonly string[],
  targetTenantId: string,
): GuardResult {
  const others = [...new Set(tenantIdsForUser)].filter((id) => id !== targetTenantId);
  return others.length === 0
    ? OK
    : {
        ok: false,
        error:
          "That user already belongs to another tenant. Sign-in requires exactly one tenant, so a second membership would lock them out entirely.",
      };
}
