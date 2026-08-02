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
    const rows = enforcing
      ? await basePrisma.$queryRaw<Array<{ key: string }>>`
          SELECT DISTINCT rp."permissionKey" AS key
          FROM "UserRole" ur
          JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
          WHERE ur."userId" = ${userId}
            AND ur."tenantId" IS NOT DISTINCT FROM ${currentTenantScope()?.tenantId ?? null}
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
