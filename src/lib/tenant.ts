/**
 * Tenant foundation helpers (multi-tenancy PR1). Deliberately PURE and
 * dependency-free — no `server-only`, no Prisma — so they can be unit-tested and
 * imported anywhere. The DB-backed accessor and request-context/session wiring
 * arrive in a later PR (see MULTITENANCY-SCOPING.md).
 */

/**
 * The founding organization seeded for the existing Denago business by migration
 * 20260721130000_tenant_foundation. Until sessions carry an org claim this is the
 * fallback active tenant, so single-tenant behaviour is unchanged.
 */
export const DEFAULT_ORG_ID = "org_denago_cpt";

/**
 * Choose a user's active organization from their memberships: the earliest-joined
 * one, or the founding Denago org when they have none. Does not mutate the input.
 */
export function pickActiveOrg(
  memberships: { organizationId: string; createdAt: Date }[],
): string {
  if (memberships.length === 0) return DEFAULT_ORG_ID;
  return [...memberships].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )[0].organizationId;
}
