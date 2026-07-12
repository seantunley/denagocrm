"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { PERMISSIONS, requirePermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";
import { bumpUserSessionVersion } from "@/lib/userSecurity";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();
const permissionSet = new Set<string>(PERMISSIONS);
const REQUIRED_ADMIN_PERMISSIONS = new Set([
  "roles.view",
  "roles.manage",
  "teams.view",
  "teams.manage",
  "audit.view",
  "audit.export",
]);

async function validUserId(userId: string | null) {
  if (!userId) return null;
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} LIMIT 1
  `;
  if (!rows[0]) throw new Error("Selected user does not exist");
  return userId;
}

async function otherGovernanceAdminCount(excludedUserId?: string, excludedRoleId?: string): Promise<number> {
  const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT u."id")::bigint AS count
    FROM "User" u
    WHERE u."disabledAt" IS NULL
      AND (${excludedUserId ?? null}::text IS NULL OR u."id" <> ${excludedUserId ?? null})
      AND (
        u."role" = 'owner'
        OR EXISTS (
          SELECT 1
          FROM "UserRole" ur
          JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
          WHERE ur."userId" = u."id"
            AND rp."permissionKey" = 'roles.manage'
            AND (${excludedRoleId ?? null}::text IS NULL OR ur."roleId" <> ${excludedRoleId ?? null})
        )
      )
  `;
  return Number(rows[0]?.count ?? 0);
}

async function roleIdsGrantAdmin(roleIds: string[]): Promise<boolean> {
  if (roleIds.length === 0) return false;
  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "RolePermission"
      WHERE "roleId" = ANY(${roleIds}::text[])
        AND "permissionKey" = 'roles.manage'
    ) AS allowed
  `;
  return Boolean(rows[0]?.allowed);
}

export async function createTeam(formData: FormData) {
  const user = await requirePermission("teams.manage");
  const name = value(formData, "name");
  if (!name) throw new Error("Team name is required");
  const id = crypto.randomUUID();
  const managerId = await validUserId(value(formData, "managerId") || null);
  const description = value(formData, "description") || null;
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "Team" ("id", "name", "description", "managerId")
      VALUES (${id}, ${name}, ${description}, ${managerId})
    `;
    if (managerId) {
      await tx.$executeRaw`
        INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager")
        VALUES (${crypto.randomUUID()}, ${id}, ${managerId}, true)
        ON CONFLICT ("teamId", "userId") DO UPDATE SET "isManager" = true
      `;
    }
  });
  await logAuditStrict({
    action: "team.created",
    summary: `Created team “${name}”`,
    entityType: "Team",
    entityId: id,
    user,
    after: { name, description, managerId, active: true },
  });
  revalidatePath("/settings/access");
}

export async function updateTeam(id: string, formData: FormData) {
  const user = await requirePermission("teams.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "Team" WHERE "id" = ${id} AND "deletedAt" IS NULL LIMIT 1
  `;
  if (!before[0]) throw new Error("Team not found");
  const name = value(formData, "name");
  if (!name) throw new Error("Team name is required");
  const managerId = await validUserId(value(formData, "managerId") || null);
  const description = value(formData, "description") || null;
  const active = formData.get("active") === "on";
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "Team"
      SET "name" = ${name}, "description" = ${description}, "managerId" = ${managerId},
        "active" = ${active}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "deletedAt" IS NULL
    `;
    await tx.$executeRaw`UPDATE "TeamMember" SET "isManager" = false WHERE "teamId" = ${id}`;
    if (managerId) {
      await tx.$executeRaw`
        INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager")
        VALUES (${crypto.randomUUID()}, ${id}, ${managerId}, true)
        ON CONFLICT ("teamId", "userId") DO UPDATE SET "isManager" = true
      `;
    }
  });
  await logAuditStrict({
    action: "team.updated",
    summary: `Updated team “${name}”`,
    entityType: "Team",
    entityId: id,
    user,
    before: before[0],
    after: { name, description, managerId, active },
  });
  revalidatePath("/settings/access");
}

export async function addTeamMember(teamId: string, formData: FormData) {
  const user = await requirePermission("teams.manage");
  const userId = await validUserId(value(formData, "userId") || null);
  if (!userId) return;
  const team = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Team" WHERE "id" = ${teamId} AND "deletedAt" IS NULL LIMIT 1
  `;
  if (!team[0]) throw new Error("Team not found");
  await basePrisma.$executeRaw`
    INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager")
    VALUES (${crypto.randomUUID()}, ${teamId}, ${userId}, false)
    ON CONFLICT DO NOTHING
  `;
  await logAuditStrict({
    action: "team.member_added",
    summary: "Added user to team",
    entityType: "Team",
    entityId: teamId,
    user,
    after: { userId },
  });
  revalidatePath("/settings/access");
}

export async function removeTeamMember(teamId: string, memberUserId: string, formData: FormData) {
  void formData;
  const user = await requirePermission("teams.manage");
  const before = await basePrisma.$queryRaw<Array<{ isManager: boolean }>>`
    SELECT "isManager" FROM "TeamMember" WHERE "teamId" = ${teamId} AND "userId" = ${memberUserId} LIMIT 1
  `;
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "TeamMember" WHERE "teamId" = ${teamId} AND "userId" = ${memberUserId}`;
    if (before[0]?.isManager) {
      await tx.$executeRaw`
        UPDATE "Team" SET "managerId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${teamId} AND "managerId" = ${memberUserId}
      `;
    }
  });
  await logAuditStrict({
    action: "team.member_removed",
    summary: "Removed user from team",
    entityType: "Team",
    entityId: teamId,
    user,
    before: { userId: memberUserId, isManager: before[0]?.isManager ?? false },
  });
  revalidatePath("/settings/access");
}

export async function createRole(formData: FormData) {
  const user = await requirePermission("roles.manage");
  const name = value(formData, "name");
  if (!name) throw new Error("Role name is required");
  const id = crypto.randomUUID();
  const description = value(formData, "description") || null;
  await basePrisma.$executeRaw`
    INSERT INTO "Role" ("id", "name", "description") VALUES (${id}, ${name}, ${description})
  `;
  await logAuditStrict({
    action: "role.created",
    summary: `Created role “${name}”`,
    entityType: "Role",
    entityId: id,
    user,
    after: { name, description },
  });
  revalidatePath("/settings/access");
}

export async function updateRolePermissions(roleId: string, formData: FormData) {
  const user = await requirePermission("roles.manage");
  const roles = await basePrisma.$queryRaw<Array<{ id: string; name: string; system: boolean }>>`
    SELECT "id", "name", "system" FROM "Role" WHERE "id" = ${roleId} LIMIT 1
  `;
  const role = roles[0];
  if (!role) throw new Error("Role not found");
  const before = await basePrisma.$queryRaw<Array<{ permissionKey: string }>>`
    SELECT "permissionKey" FROM "RolePermission" WHERE "roleId" = ${roleId} ORDER BY "permissionKey"
  `;
  const beforeKeys = before.map((item) => item.permissionKey);
  const permissions = [...new Set(formData.getAll("permissions").map(String))]
    .filter((permission) => permissionSet.has(permission));

  if (roleId === "role_crm_admin") {
    const missing = [...REQUIRED_ADMIN_PERMISSIONS].filter((permission) => !permissions.includes(permission));
    if (missing.length) throw new Error(`CRM administrator must retain: ${missing.join(", ")}`);
  }
  if (beforeKeys.includes("roles.manage") && !permissions.includes("roles.manage")) {
    const remaining = await otherGovernanceAdminCount(undefined, roleId);
    if (remaining < 1) throw new Error("This change would remove the last governance administrator");
  }

  const assignedUsers = await basePrisma.$queryRaw<Array<{ userId: string }>>`
    SELECT "userId" FROM "UserRole" WHERE "roleId" = ${roleId}
  `;
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${roleId}`;
    for (const permission of permissions) {
      await tx.$executeRaw`
        INSERT INTO "RolePermission" ("roleId", "permissionKey")
        VALUES (${roleId}, ${permission}) ON CONFLICT DO NOTHING
      `;
    }
    if (assignedUsers.length) {
      await tx.$executeRaw`
        UPDATE "User"
        SET "sessionVersion" = "sessionVersion" + 1
        WHERE "id" = ANY(${assignedUsers.map((item) => item.userId)}::text[])
      `;
    }
  });
  await logAuditStrict({
    action: "role.permissions_updated",
    summary: `Updated permissions for role “${role.name}”; affected sessions revoked`,
    entityType: "Role",
    entityId: roleId,
    user,
    before: { permissions: beforeKeys },
    after: { permissions },
  });
  revalidatePath("/settings/access");
}

export async function updateUserRoles(userId: string, formData: FormData) {
  const actor = await requirePermission("roles.manage");
  await validUserId(userId);
  const requested = [...new Set(formData.getAll("roles").map(String))];
  const allRoles = await basePrisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Role"`;
  const validRoleSet = new Set(allRoles.map((role) => role.id));
  const validRoleIds = requested.filter((roleId) => validRoleSet.has(roleId));
  const before = await basePrisma.$queryRaw<Array<{ roleId: string }>>`
    SELECT "roleId" FROM "UserRole" WHERE "userId" = ${userId} ORDER BY "roleId"
  `;
  const targetRows = await basePrisma.$queryRaw<Array<{ role: string; disabledAt: Date | null }>>`
    SELECT "role", "disabledAt" FROM "User" WHERE "id" = ${userId} LIMIT 1
  `;
  const target = targetRows[0];
  if (!target) throw new Error("User not found");

  const hadAdmin = target.role === "owner" || await roleIdsGrantAdmin(before.map((item) => item.roleId));
  const keepsAdmin = target.role === "owner" || await roleIdsGrantAdmin(validRoleIds);
  if (hadAdmin && !keepsAdmin && !target.disabledAt) {
    const remaining = await otherGovernanceAdminCount(userId);
    if (remaining < 1) throw new Error("This change would remove the last governance administrator");
  }

  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "UserRole" WHERE "userId" = ${userId}`;
    for (const roleId of validRoleIds) {
      await tx.$executeRaw`
        INSERT INTO "UserRole" ("userId", "roleId") VALUES (${userId}, ${roleId}) ON CONFLICT DO NOTHING
      `;
    }
    await tx.$executeRaw`
      UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE "id" = ${userId}
    `;
  });
  await logAuditStrict({
    action: "user.roles_updated",
    summary: "Updated user roles; active sessions revoked",
    entityType: "User",
    entityId: userId,
    user: actor,
    before: { roles: before.map((item) => item.roleId) },
    after: { roles: validRoleIds },
  });
  revalidatePath("/settings/access");
  revalidatePath("/settings");
  await bumpUserSessionVersion(actor.id).catch(() => {});
}
