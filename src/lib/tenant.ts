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
