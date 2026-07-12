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
  "leads.mark_won",
  "leads.mark_lost",
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

export async function getUserPermissions(userId: string): Promise<Set<string>> {
  const rows = await basePrisma.$queryRaw<Array<{ key: string }>>`
    SELECT DISTINCT rp."permissionKey" AS key
    FROM "UserRole" ur
    JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
    WHERE ur."userId" = ${userId}
  `;
  return new Set(rows.map((row) => row.key));
}

export async function hasPermission(user: PermissionUser, permission: PermissionKey): Promise<boolean> {
  if (user.role === "owner") return true;
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(permission)) return true;

  // Compatibility fallback during rollout: current members retain the module
  // access they already had until explicit roles are reviewed in Settings.
  const modules = new Set(user.modules.split(",").map((item) => item.trim()).filter(Boolean));
  if (permission.startsWith("leads.") || permission.startsWith("pipelines.") || permission.startsWith("forecast.")) {
    return modules.has("crm");
  }
  if (permission === "reports.view") return modules.has("reports");
  if (permission === "workshop.manage") return modules.has("workshop");
  return false;
}

export async function requirePermission(permission: PermissionKey): Promise<PermissionUser> {
  const user = await requireUser();
  if (!(await hasPermission(user, permission))) redirect("/");
  return user;
}

export async function getUserTeamIds(userId: string): Promise<string[]> {
  const rows = await basePrisma.$queryRaw<Array<{ teamId: string }>>`
    SELECT "teamId" FROM "TeamMember" WHERE "userId" = ${userId}
  `;
  return rows.map((row) => row.teamId);
}

export async function canAccessLead(user: PermissionUser, leadId: string): Promise<boolean> {
  if (user.role === "owner") return true;
  const permissions = await getUserPermissions(user.id);
  if (permissions.has("leads.view_all")) return true;
  if (!permissions.has("leads.view_owned") && !user.modules.split(",").includes("crm")) return false;

  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l."id" = ${leadId}
        AND (
          l."assignedToId" = ${user.id}
          OR l."createdById" = ${user.id}
          OR l."teamId" IN (SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${user.id})
        )
    ) AS allowed
  `;
  return Boolean(rows[0]?.allowed);
}

export async function requireLeadAccess(leadId: string, permission: PermissionKey): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessLead(user, leadId))) redirect("/leads");
  return user;
}

export async function getAccessibleLeadScope(user: PermissionUser): Promise<{
  viewAll: boolean;
  userId: string;
  teamIds: string[];
}> {
  if (user.role === "owner") return { viewAll: true, userId: user.id, teamIds: [] };
  const permissions = await getUserPermissions(user.id);
  return {
    viewAll: permissions.has("leads.view_all"),
    userId: user.id,
    teamIds: await getUserTeamIds(user.id),
  };
}
