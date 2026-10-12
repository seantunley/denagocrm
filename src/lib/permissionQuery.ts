import { basePrisma } from "./db";
import { tenantEnforcing } from "./tenantEnforcement";
import { currentTenantScope } from "./tenantScope";

/**
 * The raw RBAC lookup, kept in its own module so BOTH sides of the single
 * authorization source can reach it without an import cycle: permissions.ts
 * (which imports auth.ts for requireUser) exposes the guards, while auth.ts
 * needs the same query at session-mint time to derive the proxy's route-grant
 * claim. Importing permissions.ts from auth.ts would close the loop
 * auth → permissions → auth.
 */

export const RBAC_UNAVAILABLE = "__rbac_unavailable__";
export const RBAC_INITIALIZED = "__rbac_initialized__";

/**
 * The workspace a role lookup is made in: the bound one, or — when none is bound
 * — the signed-in session's own, re-derived here.
 *
 * WHY THE SECOND HALF. In a Server Action the scope `getCurrentUser()` enters does
 * not reach the action that called it (scopeRecovery.ts has the measurements).
 * The tenant-scoped `prisma` and the record-access checks each recover it at their
 * own point of use; this lookup did not. So in any action not wrapped in
 * `withActingStaffScope`, a member's roles were looked up in NO workspace, none
 * were found, and `requirePermission` sent them to the home page — for holding
 * exactly the permission the action asked for. Owners never reach this query,
 * which is how it went unseen: found 2026-10-12 when a sales rep opening the
 * email composer was redirected away from the customer she was writing to.
 *
 * It cannot widen anything. It runs only when NO scope is bound, and yields the
 * session's own workspace (fully revalidated: revocation, disabled account,
 * session version) or nothing. With no session at all — the WhatsApp door, a
 * cron — it is null, as it was.
 */
export async function workspaceForRoleLookup(
  bound: { tenantId?: string | null } | null | undefined,
  recover: () => Promise<{ tenantId?: string | null } | null>,
): Promise<string | null> {
  // A bound scope always wins — one with no workspace (the global owner's) included.
  if (bound) return bound.tenantId ?? null;
  return (await recover())?.tenantId ?? null;
}

const actingWorkspaceId = () =>
  workspaceForRoleLookup(currentTenantScope(), async () => {
    // Imported here, not at the top: scopeRecovery is server-only and reaches the session modules.
    const { recoverStaffScopeFromSession } = await import("./scopeRecovery");
    return recoverStaffScopeFromSession();
  });

/**
 * THE RBAC enforcement flip (see the deferred-scoping notes in settings.ts's
 * createUser and accessControl.ts's updateUserRoles): every UserRole write already
 * stamps its owning tenant, but reads stayed tenant-agnostic on purpose, so this one
 * change had to land atomically with the rest of the tenant-enforcement rollout (and
 * its lockout-proofing) — not piecemeal. It has now landed alongside that rollout.
 *
 * DORMANT off: identical query to before (every role assignment the user holds, in
 * any tenant) — today's single-tenant behaviour, byte-for-byte.
 * ENFORCING: scoped to the active tenant's assignments only, so a user who belongs
 * to two tenants no longer receives the UNION of both tenants' privileges — only the
 * one they're currently acting in.
 */
export async function getUserPermissions(userId: string): Promise<Set<string>> {
  try {
    const enforcing = tenantEnforcing();
    const tenantId = enforcing ? await actingWorkspaceId() : null;
    const rows = enforcing
      ? await basePrisma.$queryRaw<Array<{ key: string }>>`
          SELECT DISTINCT rp."permissionKey" AS key
          FROM "UserRole" ur
          JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
          WHERE ur."userId" = ${userId}
            AND ur."tenantId" IS NOT DISTINCT FROM ${tenantId}
          UNION
          SELECT ${RBAC_INITIALIZED} AS key
          WHERE EXISTS (SELECT 1 FROM "Role" LIMIT 1)
        `
      : await basePrisma.$queryRaw<Array<{ key: string }>>`
          SELECT DISTINCT rp."permissionKey" AS key
          FROM "UserRole" ur
          JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
          WHERE ur."userId" = ${userId}
          UNION
          SELECT ${RBAC_INITIALIZED} AS key
          WHERE EXISTS (SELECT 1 FROM "Role" LIMIT 1)
        `;
    return new Set(rows.map((row) => row.key));
  } catch {
    return new Set([RBAC_UNAVAILABLE]);
  }
}

/**
 * The permission keys a grant set actually confers. A database that is
 * unreachable or has no role catalogue yet confers NOTHING — fail closed, the
 * same rule every guard in permissions.ts applies.
 */
export function usablePermissions(granted: Set<string>): Set<string> {
  if (granted.has(RBAC_UNAVAILABLE) || !granted.has(RBAC_INITIALIZED)) return new Set();
  return new Set([...granted].filter((key) => !key.startsWith("__")));
}
