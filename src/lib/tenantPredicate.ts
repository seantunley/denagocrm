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

/**
 * Async counterpart for USER/REQUEST helpers that can legitimately recover a
 * staff Server Action or route-handler scope which was lost between async frames.
 *
 * Start with the synchronous rule above so an existing tenant scope, an explicit
 * null/system scope, and dormant mode behave byte-for-byte as before. Recovery is
 * attempted ONLY for the one state the synchronous function refuses: enforcement
 * is on and this execution context has no scope at all.
 *
 * The recovery revalidates the signed staff session (revocation, disabled account,
 * session version and tenant membership) and never invents a workspace. If it
 * cannot prove one, rethrow the ORIGINAL contextual TenantScopeError so the caller
 * still fails closed with the operation name that actually needed the boundary.
 *
 * Do NOT use this for a webhook/cron whose tenant comes from the record/provider.
 * Those paths should bind that owner explicitly before calling their synchronous
 * predicate. A genuinely sessionless missing-scope caller reaches recovery, finds
 * no staff session, and still fails closed — but deriving a background owner from
 * a user session would be the wrong abstraction even if one happened to exist.
 */
export async function recoverableActiveTenantPredicate(
  context: string,
): Promise<{ tenantId?: string | null }> {
  try {
    return activeTenantPredicate(context);
  } catch (error) {
    if (!(error instanceof TenantScopeError) || currentTenantScope()) throw error;
    const { recoverStaffScopeFromSession } = await import("./scopeRecovery");
    const recovered = await recoverStaffScopeFromSession();
    if (!recovered?.tenantId) throw error;
    return { tenantId: recovered.tenantId };
  }
}
