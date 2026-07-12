"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

export async function createTeam(formData: FormData) {
  const user = await requirePermission("teams.manage");
  const name = value(formData, "name");
  if (!name) throw new Error("Team name is required");
  const id = crypto.randomUUID();
  const managerId = value(formData, "managerId") || null;
  await basePrisma.$executeRaw`
    INSERT INTO "Team" ("id", "name", "description", "managerId")
    VALUES (${id}, ${name}, ${value(formData, "description") || null}, ${managerId})
  `;
  if (managerId) await basePrisma.$executeRaw`
    INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager") VALUES (${crypto.randomUUID()}, ${id}, ${managerId}, true)
    ON CONFLICT ("teamId", "userId") DO UPDATE SET "isManager" = true
  `;
  await logAuditStrict({ action: "team.created", summary: `Created team “${name}”`, entityType: "Team", entityId: id, user, after: { name, managerId } });
  revalidatePath("/settings/access");
}

export async function updateTeam(id: string, formData: FormData) {
  const user = await requirePermission("teams.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "Team" WHERE "id" = ${id} LIMIT 1`;
  const name = value(formData, "name");
  if (!name) throw new Error("Team name is required");
  const managerId = value(formData, "managerId") || null;
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "Team" SET "name" = ${name}, "description" = ${value(formData, "description") || null}, "managerId" = ${managerId}, "active" = ${formData.get("active") === "on"}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`;
    await tx.$executeRaw`UPDATE "TeamMember" SET "isManager" = false WHERE "teamId" = ${id}`;
    if (managerId) await tx.$executeRaw`INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager") VALUES (${crypto.randomUUID()}, ${id}, ${managerId}, true) ON CONFLICT ("teamId", "userId") DO UPDATE SET "isManager" = true`;
  });
  await logAuditStrict({ action: "team.updated", summary: `Updated team “${name}”`, entityType: "Team", entityId: id, user, before: before[0], after: { name, managerId } });
  revalidatePath("/settings/access");
}

export async function addTeamMember(teamId: string, formData: FormData) {
  const user = await requirePermission("teams.manage");
  const userId = value(formData, "userId");
  if (!userId) return;
  await basePrisma.$executeRaw`INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager") VALUES (${crypto.randomUUID()}, ${teamId}, ${userId}, false) ON CONFLICT DO NOTHING`;
  await logAuditStrict({ action: "team.member_added", summary: "Added user to team", entityType: "Team", entityId: teamId, user, after: { userId } });
  revalidatePath("/settings/access");
}

export async function removeTeamMember(teamId: string, memberUserId: string, formData: FormData) {
  void formData;
  const user = await requirePermission("teams.manage");
  await basePrisma.$executeRaw`DELETE FROM "TeamMember" WHERE "teamId" = ${teamId} AND "userId" = ${memberUserId}`;
  await logAuditStrict({ action: "team.member_removed", summary: "Removed user from team", entityType: "Team", entityId: teamId, user, before: { userId: memberUserId } });
  revalidatePath("/settings/access");
}

export async function createRole(formData: FormData) {
  const user = await requirePermission("roles.manage");
  const name = value(formData, "name");
  if (!name) throw new Error("Role name is required");
  const id = crypto.randomUUID();
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id", "name", "description") VALUES (${id}, ${name}, ${value(formData, "description") || null})`;
  await logAuditStrict({ action: "role.created", summary: `Created role “${name}”`, entityType: "Role", entityId: id, user, after: { name } });
  revalidatePath("/settings/access");
}

export async function updateRolePermissions(roleId: string, formData: FormData) {
  const user = await requirePermission("roles.manage");
  const permissions = formData.getAll("permissions").map(String);
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${roleId}`;
    for (const permission of permissions) await tx.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES (${roleId}, ${permission}) ON CONFLICT DO NOTHING`;
  });
  await logAuditStrict({ action: "role.permissions_updated", summary: "Updated role permissions", entityType: "Role", entityId: roleId, user, after: { permissions } });
  revalidatePath("/settings/access");
}

export async function updateUserRoles(userId: string, formData: FormData) {
  const actor = await requirePermission("roles.manage");
  const roles = formData.getAll("roles").map(String);
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "UserRole" WHERE "userId" = ${userId}`;
    for (const roleId of roles) await tx.$executeRaw`INSERT INTO "UserRole" ("userId", "roleId") VALUES (${userId}, ${roleId}) ON CONFLICT DO NOTHING`;
  });
  await logAuditStrict({ action: "user.roles_updated", summary: "Updated user roles", entityType: "User", entityId: userId, user: actor, after: { roles } });
  revalidatePath("/settings/access");
}
