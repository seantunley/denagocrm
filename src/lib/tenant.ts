/**
 * Tenant foundation helpers (multi-tenancy PR1). Deliberately PURE and
 * dependency-free — no `server-only`, no Prisma — so they can be unit-tested and
 * imported anywhere. The DB-backed accessor and request-context/session wiring
 * arrive in a later PR (see MULTITENANCY-SCOPING.md).
 */

/**
 * The founding tenant seeded for the existing Denago business by migration
 * 20260721130000_tenant_foundation. Use this ONLY to EXPLICITLY provision the
 * Denago tenant (migration + seed) — never as a fallback to infer tenant access
 * for a user who has no membership. Tenant access is fail-closed: it comes from a
 * real TenantMember row, not from this constant.
 */
export const DEFAULT_TENANT_ID = "tenant_denago_cpt";

/**
 * Resolve a user's active tenant from their memberships: the earliest-joined one,
 * or `null` when they belong to none. Fail-closed by design — a membership-less
 * user gets NO tenant context (callers must reject / route to provisioning), never
 * a silent default. Does not mutate the input.
 */
export function pickActiveTenant(
  memberships: { tenantId: string; createdAt: Date }[],
): string | null {
  if (memberships.length === 0) return null;
  return [...memberships].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )[0].tenantId;
}
