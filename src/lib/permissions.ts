import { redirect } from "next/navigation";
import { basePrisma } from "./db";
import { requireUser } from "./auth";

export const PERMISSIONS = [
  "pipelines.view",
  "pipelines.manage",
  "forecast.view",
  "forecast.manage",
  "leads.view_all",
  "leads.view_owned",
  "leads.create",
  "leads.edit",
  "leads.assign",
  "leads.change_stage",
  "leads.change_pipeline",
  "leads.mark_won",
  "leads.mark_lost",
  "leads.reopen",
  "leads.link_contact",
  "leads.delete",
  "teams.view",
  "teams.manage",
  "roles.view",
  "roles.manage",
  "audit.view",
  "audit.export",
  "campaigns.manage",
  "journeys.manage",
  "workshop.manage",
  "reports.view",
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

export type PermissionUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  modules: string;
};

const RBAC_UNAVAILABLE = "__rbac_unavailable__";
const RBAC_ROLE_ASSIGNED = "__rbac_role_assigned__";

function moduleSet(user: PermissionUser) {
  return new Set(user.modules.split(",").map((item) => item.trim()).filter(Boolean));
}

/**
 * Explicit role permissions are authoritative. A role-assignment sentinel keeps
 * an intentionally empty role from falling back to broader legacy module access.
 * Database/query failures return a different sentinel and fail closed.
 */
export async function getUserPermissions(userId: string): Promise<Set<string>> {
  try {
    const rows = await basePrisma.$queryRaw<Array<{ key: string }>>`
      SELECT DISTINCT rp."permissionKey" AS key
      FROM "UserRole" ur
      JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
      WHERE ur."userId" = ${userId}
      UNION
      SELECT ${RBAC_ROLE_ASSIGNED} AS key
      WHERE EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = ${userId})
    `;
    return new Set(rows.map((row) => row.key));
  } catch {
    return new Set([RBAC_UNAVAILABLE]);
  }
}

function hasExplicitRole(permissions: Set<string>) {
  return permissions.has(RBAC_ROLE_ASSIGNED);
}

function legacyModuleAllows(user: PermissionUser, permission: PermissionKey): boolean {
  const modules = moduleSet(user);
  const crmFallback = new Set<PermissionKey>([
    "pipelines.view",
    "forecast.view",
    "leads.view_owned",
    "leads.create",
    "leads.edit",
    "leads.change_stage",
    "leads.mark_won",
    "leads.mark_lost",
    "leads.reopen",
    "leads.link_contact",
  ]);
  if (crmFallback.has(permission)) return modules.has("crm");
  if (permission === "reports.view") return modules.has("reports");
  if (permission === "workshop.manage") return modules.has("workshop");
  return false;
}

export async function hasPermission(user: PermissionUser, permission: PermissionKey): Promise<boolean> {
  if (user.role === "owner") return true;
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(RBAC_UNAVAILABLE)) return false;
  if (hasExplicitRole(permissions)) return permissions.has(permission);
  return legacyModuleAllows(user, permission);
}

export async function requirePermission(permission: PermissionKey): Promise<PermissionUser> {
  const user = await requireUser();
  if (!(await hasPermission(user, permission))) redirect("/");
  return user;
}

export async function requireAnyPermission(...permissions: PermissionKey[]): Promise<PermissionUser> {
  const user = await requireUser();
  const checks = await Promise.all(permissions.map((permission) => hasPermission(user, permission)));
  if (!checks.some(Boolean)) redirect("/");
  return user;
}

export async function getUserTeamIds(userId: string): Promise<string[]> {
  try {
    const rows = await basePrisma.$queryRaw<Array<{ teamId: string }>>`
      SELECT DISTINCT scope."teamId"
      FROM (
        SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${userId}
        UNION
        SELECT t."id" AS "teamId" FROM "Team" t
        WHERE t."managerId" = ${userId} AND t."active" = true AND t."deletedAt" IS NULL
      ) scope
    `;
    return rows.map((row) => row.teamId);
  } catch {
    return [];
  }
}

async function canViewOwnedRecords(user: PermissionUser, permissions: Set<string>) {
  if (permissions.has(RBAC_UNAVAILABLE)) return false;
  if (hasExplicitRole(permissions)) return permissions.has("leads.view_owned");
  return moduleSet(user).has("crm");
}

export async function canAccessLead(user: PermissionUser, leadId: string): Promise<boolean> {
  if (user.role === "owner") return true;
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(RBAC_UNAVAILABLE)) return false;
  if (permissions.has("leads.view_all")) return true;
  if (!(await canViewOwnedRecords(user, permissions))) return false;

  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l."id" = ${leadId}
        AND l."deletedAt" IS NULL
        AND (
          l."assignedToId" = ${user.id}
          OR l."createdById" = ${user.id}
          OR l."teamId" IN (
            SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${user.id}
            UNION
            SELECT t."id" FROM "Team" t WHERE t."managerId" = ${user.id} AND t."deletedAt" IS NULL
          )
        )
    ) AS allowed
  `;
  return Boolean(rows[0]?.allowed);
}

export async function requireLeadReadAccess(leadId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  if (!(await canAccessLead(user, leadId))) redirect("/leads");
  return user;
}

export async function requireLeadAccess(leadId: string, permission: PermissionKey): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessLead(user, leadId))) redirect("/leads");
  return user;
}

export async function getAccessibleLeadScope(user: PermissionUser): Promise<{
  viewAll: boolean;
  viewOwned: boolean;
  userId: string;
  teamIds: string[];
}> {
  if (user.role === "owner") {
    return { viewAll: true, viewOwned: true, userId: user.id, teamIds: [] };
  }
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(RBAC_UNAVAILABLE)) {
    return { viewAll: false, viewOwned: false, userId: user.id, teamIds: [] };
  }
  const viewAll = permissions.has("leads.view_all");
  const viewOwned = viewAll || await canViewOwnedRecords(user, permissions);
  return {
    viewAll,
    viewOwned,
    userId: user.id,
    teamIds: viewOwned ? await getUserTeamIds(user.id) : [],
  };
}

/** Null means unrestricted; an array is the complete accessible lead ID set. */
export async function getAccessibleLeadIds(user: PermissionUser): Promise<string[] | null> {
  const scope = await getAccessibleLeadScope(user);
  if (scope.viewAll) return null;
  if (!scope.viewOwned) return [];
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT l."id"
    FROM "Lead" l
    WHERE l."deletedAt" IS NULL
      AND (
        l."assignedToId" = ${scope.userId}
        OR l."createdById" = ${scope.userId}
        OR l."teamId" IN (
          SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${scope.userId}
          UNION
          SELECT t."id" FROM "Team" t WHERE t."managerId" = ${scope.userId} AND t."deletedAt" IS NULL
        )
      )
  `;
  return rows.map((row) => row.id);
}
