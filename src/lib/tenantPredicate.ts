// Deliberately NOT "server-only". This is a pure predicate builder — no DB, no
// secrets — and marking it server-only would make the enforce-without-scope
// case untestable, which is the one case that actually reopened cross-tenant
// writes. Its callers are server-only; that is where the boundary belongs.
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { TenantScopeError } from "./tenantGuard";

/**
 * The active tenant as an explicit `where` fragment, for the handful of queries
 * that run on `basePrisma` and therefore BYPASS the RLS extension.
 *
 * Three cases, and all three matter:
 *
 *  1. NOT ENFORCING → `{}`. establishStaffTenantScope enters no scope at all
 *     unless TENANT_ENFORCEMENT=enforce, and off/monitor are the documented
 *     default and rollback modes. Returning `{ tenantId: null }` here would
 *     filter on the legacy untenanted value, so every migrated record would
 *     stop matching: documents unreadable, soft deletes silent no-ops, Trash
 *     empty. No scope means we were never told which tenant this is, which is
 *     not a filter.
 *
 *  2. ENFORCING WITH A SCOPE → that tenant. A scope genuinely carrying null
 *     still filters on null; legacy rows are that tenant's rows.
 *
 *  3. ENFORCING WITHOUT A SCOPE → THROW. This is not hypothetical: under
 *     enforcement establishStaffTenantScope deliberately lets a GLOBAL OWNER
 *     continue with no scope when tenant resolution fails (the owner escape
 *     hatch), so the platform console still works. The (app) layout redirects
 *     that owner — but server actions execute independently of any layout and
 *     gate only on requireOwner()/requirePermission(). Returning `{}` there
 *     would hand them every tenant's documents, and let them soft-delete or
 *     restore another tenant's records by id.
 *
 *     Throwing is the same answer the db guard already gives for a scopeless
 *     enforced query, so this is the existing posture applied to the queries
 *     that opted out of the extension — not a second, quieter rule.
 */
export function activeTenantPredicate(context: string): { tenantId?: string | null } {
  const scope = currentTenantScope();
  if (scope) return { tenantId: scope.tenantId };
  if (tenantEnforcing()) {
    throw new TenantScopeError(
      `${context}: tenant enforcement is on but this request has no tenant scope. ` +
        "A global owner without a resolved tenant must use the platform console, " +
        "not tenant-scoped data.",
    );
  }
  return {};
}
