"use server";


import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { canEditRole } from "@/lib/tenantGuard";
import { PERMISSIONS, requirePermission } from "@/lib/permissions";
import { GOVERNANCE_TX, logAuditStrict } from "@/lib/audit";
import { bumpUserSessionVersion } from "@/lib/userSecurity";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/**
 * Team and Role names are uniquely constrained. Reusing one raised a raw
 * Postgres 23505, which Next digests into "Something went wrong" — so the one
 * thing the person needed to know (pick another name) was the one thing they
 * were not told. A name clash is an expected refusal, not a system failure.
 */
async function refusingDuplicateName<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = (error as { code?: string })?.code;
    if (code === "P2002" || message.includes("23505") || message.includes("already exists")) {
      refuse(`A ${what} with that name already exists. Choose another name.`);
    }
    throw error;
  }
}
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
  // A refusal, not an Error: a stale user list is something the person can fix
  // by refreshing. Every caller authorises before reaching here.
  if (!rows[0]) refuse("That teammate no longer exists. Refresh and try again.");
  // Under enforcement verify the target user is a member of the caller's tenant.
  // Without this check a roles.manage holder can target accounts from other tenants.
  if (tenantEnforcing()) {
    const activeTenantId = await getActiveTenantId();
    if (activeTenantId) {
      const membership = await basePrisma.$queryRaw<Array<{ userId: string }>>`
        SELECT "userId" FROM "TenantMember"
        WHERE "tenantId" = ${activeTenantId} AND "userId" = ${userId}
        LIMIT 1
      `;
      if (!membership[0]) throw new Error("Selected user is not a member of this workspace");
    }
  }
  return userId;
}

async function otherGovernanceAdminCount(activeTenantId: string | null, excludedUserId?: string, excludedRoleId?: string): Promise<number> {
  // When tenantId is known, count only admins belonging to THAT tenant — the
  // global platform owner counts only if they are also a member of that tenant,
  // and role-based admins only via assignments scoped to that tenant. Otherwise
  // (no tenantId, pre-enforcement) count globally as before.
  const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT u."id")::bigint AS count
    FROM "User" u
    WHERE u."disabledAt" IS NULL
      AND (${excludedUserId ?? null}::text IS NULL OR u."id" <> ${excludedUserId ?? null})
      AND (
        (
          u."role" = 'owner'
          AND (
            ${activeTenantId ?? null}::text IS NULL
            OR EXISTS (
              SELECT 1 FROM "TenantMember" tm
              WHERE tm."userId" = u."id" AND tm."tenantId" = ${activeTenantId ?? null}
            )
          )
        )
        OR EXISTS (
          SELECT 1
          FROM "UserRole" ur
          JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
          WHERE ur."userId" = u."id"
            AND rp."permissionKey" = 'roles.manage'
            AND (${activeTenantId ?? null}::text IS NULL OR ur."tenantId" IS NOT DISTINCT FROM ${activeTenantId ?? null})
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
  return asActionResult(async () => {
    const user = await requirePermission("teams.manage");
    const name = value(formData, "name");
    if (!name) throw new ActionRefusal("Team name is required");
    const id = crypto.randomUUID();
    const managerId = await validUserId(value(formData, "managerId") || null);
    const description = value(formData, "description") || null;
    // A team created with tenantId IS NULL enters no tenant's namespace and is
    // inaccessible once enforcement is active. Require an active tenant
    // unconditionally — not just under enforcement — so data is always labelled
    // correctly from the start.
    const activeTenantId = await getActiveTenantId();
    if (!activeTenantId) throw new ActionRefusal("No active tenant");
    await refusingDuplicateName("team", () =>
      basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Team" ("id", "name", "description", "managerId", "tenantId")
          VALUES (${id}, ${name}, ${description}, ${managerId}, ${activeTenantId})
        `;
        if (managerId) {
          await tx.$executeRaw`
            INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager", "tenantId")
            VALUES (${crypto.randomUUID()}, ${id}, ${managerId}, true, ${activeTenantId})
            ON CONFLICT ("teamId", "userId") DO UPDATE SET "isManager" = true
          `;
        }
        // Inside the transaction: a governance audit that cannot be written must
        // roll the change back, not leave it committed while the person is told
        // the save failed. That is what makes this the STRICT logger.
        await logAuditStrict({
          action: "team.created",
          summary: `Created team “${name}”`,
          entityType: "Team",
          entityId: id,
          user,
          after: { name, description, managerId, active: true },
        }, tx);
      }, GOVERNANCE_TX),
    );
    revalidatePath("/settings/access");
  });
}

export async function updateTeam(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("teams.manage");
    // Multi-tenancy readiness: Team already carries tenantId, but this lookup only
    // ever filtered by id/deletedAt. Gated on tenantEnforcing() so today's (every
    // environment) behaviour is unchanged byte-for-byte.
    const enforcing = tenantEnforcing();
    const activeTenantId = await getActiveTenantId();
    const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "Team"
      WHERE "id" = ${id} AND "deletedAt" IS NULL
        AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      LIMIT 1
    `;
    if (!before[0]) throw new ActionRefusal("Team not found");
    const name = value(formData, "name");
    if (!name) throw new ActionRefusal("Team name is required");
    const managerId = await validUserId(value(formData, "managerId") || null);
    const description = value(formData, "description") || null;
    const active = formData.get("active") === "on";
    // Renaming onto an existing team's name clashes exactly like creating one.
    await refusingDuplicateName("team", () =>
      basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "Team"
          SET "name" = ${name}, "description" = ${description}, "managerId" = ${managerId},
            "active" = ${active}, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${id} AND "deletedAt" IS NULL
            AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
        `;
        await tx.$executeRaw`
          UPDATE "TeamMember" SET "isManager" = false
          WHERE "teamId" = ${id}
            AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
        `;
        if (managerId) {
          await tx.$executeRaw`
            INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager", "tenantId")
            VALUES (${crypto.randomUUID()}, ${id}, ${managerId}, true, ${activeTenantId})
            ON CONFLICT ("teamId", "userId") DO UPDATE SET "isManager" = true
          `;
        }
        await logAuditStrict({
          action: "team.updated",
          summary: `Updated team “${name}”`,
          entityType: "Team",
          entityId: id,
          user,
          before: before[0],
          after: { name, description, managerId, active },
        }, tx);
      }, GOVERNANCE_TX),
    );
    revalidatePath("/settings/access");
  });
}

export async function addTeamMember(teamId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("teams.manage");
    const userId = await validUserId(value(formData, "userId") || null);
    if (!userId) refuse("Choose a teammate to add.");
    const enforcing = tenantEnforcing();
    const activeTenantId = await getActiveTenantId();
    const team = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Team"
      WHERE "id" = ${teamId} AND "deletedAt" IS NULL
        AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      LIMIT 1
    `;
    if (!team[0]) throw new ActionRefusal("Team not found");
    await basePrisma.$transaction(async (tx) => {
      // ON CONFLICT DO NOTHING returns zero rows when they are ALREADY a member.
      // That was reported as "Member added" and audited as if it happened. Say
      // what is true instead, and skip the audit entry for the non-event.
      const inserted = await tx.$executeRaw`
        INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager", "tenantId")
        VALUES (${crypto.randomUUID()}, ${teamId}, ${userId}, false, ${activeTenantId})
        ON CONFLICT DO NOTHING
      `;
      if (inserted === 0) refuse("They are already a member of this team.");
      await logAuditStrict({
        action: "team.member_added",
        summary: "Added user to team",
        entityType: "Team",
        entityId: teamId,
        user,
        after: { userId },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings/access");
  });
}

export async function removeTeamMember(teamId: string, memberUserId: string, formData: FormData) {
  return asActionResult(async () => {
    void formData;
    const user = await requirePermission("teams.manage");
    const enforcing = tenantEnforcing();
    const activeTenantId = await getActiveTenantId();
    const before = await basePrisma.$queryRaw<Array<{ isManager: boolean }>>`
      SELECT "isManager" FROM "TeamMember"
      WHERE "teamId" = ${teamId} AND "userId" = ${memberUserId}
        AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      LIMIT 1
    `;
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "TeamMember"
        WHERE "teamId" = ${teamId} AND "userId" = ${memberUserId}
          AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      `;
      if (before[0]?.isManager) {
        await tx.$executeRaw`
          UPDATE "Team" SET "managerId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${teamId} AND "managerId" = ${memberUserId}
            AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
        `;
      }
      await logAuditStrict({
        action: "team.member_removed",
        summary: "Removed user from team",
        entityType: "Team",
        entityId: teamId,
        user,
        before: { userId: memberUserId, isManager: before[0]?.isManager ?? false },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings/access");
  });
}

export async function createRole(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("roles.manage");
    const name = value(formData, "name");
    if (!name) throw new ActionRefusal("Role name is required");
    const id = crypto.randomUUID();
    const description = value(formData, "description") || null;
    // A role created with tenantId IS NULL enters the system-global namespace and
    // affects every tenant under enforcement. Require an active tenant
    // unconditionally so newly-created roles are always tenant-owned.
    const tenantId = await getActiveTenantId();
    if (!tenantId) throw new ActionRefusal("No active tenant");
    await refusingDuplicateName("role", () =>
      basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Role" ("id", "name", "description", "tenantId") VALUES (${id}, ${name}, ${description}, ${tenantId})
        `;
        await logAuditStrict({
          action: "role.created",
          summary: `Created role “${name}”`,
          entityType: "Role",
          entityId: id,
          user,
          after: { name, description },
        }, tx);
      }, GOVERNANCE_TX),
    );
    revalidatePath("/settings/access");
  });
}

export async function updateRolePermissions(roleId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("roles.manage");
    const roles = await basePrisma.$queryRaw<Array<{ id: string; name: string; system: boolean; tenantId: string | null }>>`
      SELECT "id", "name", "system", "tenantId" FROM "Role" WHERE "id" = ${roleId} LIMIT 1
    `;
    const role = roles[0];
    if (!role) throw new ActionRefusal("Role not found");
    // Multi-tenancy readiness: a tenant admin must not edit a SYSTEM role's
    // permissions (that would change every tenant's shared role — unaffected,
    // role.tenantId === null never trips this) nor another tenant's custom role.
    // canEditRole() is gated on tenantEnforcing() so today's (every environment)
    // behaviour is unchanged byte-for-byte; once enforcement is on, a
    // cross-tenant edit 404s exactly like updateTeam's cross-tenant Team lookup
    // does. See tenantGuard.ts / tenantGuard.test.ts for the pure decision + tests.
    const enforcing = tenantEnforcing();
    const activeTenantId = await getActiveTenantId();
    const isGlobalAdmin = user.role === "owner";
    if (!canEditRole(enforcing, role.tenantId, activeTenantId, isGlobalAdmin)) {
      throw new ActionRefusal("Role not found");
    }
    const before = await basePrisma.$queryRaw<Array<{ permissionKey: string }>>`
      SELECT "permissionKey" FROM "RolePermission" WHERE "roleId" = ${roleId} ORDER BY "permissionKey"
    `;
    const beforeKeys = before.map((item) => item.permissionKey);
    const permissions = [...new Set(formData.getAll("permissions").map(String))]
      .filter((permission) => permissionSet.has(permission));

    if (roleId === "role_crm_admin") {
      const missing = [...REQUIRED_ADMIN_PERMISSIONS].filter((permission) => !permissions.includes(permission));
      if (missing.length) throw new ActionRefusal(`CRM administrator must retain: ${missing.join(", ")}`);
    }
    if (beforeKeys.includes("roles.manage") && !permissions.includes("roles.manage")) {
      const remaining = await otherGovernanceAdminCount(activeTenantId, undefined, roleId);
      if (remaining < 1) throw new ActionRefusal("This change would remove the last governance administrator");
    }

    const assignedUsers = await basePrisma.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM "UserRole" WHERE "roleId" = ${roleId}
    `;
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${roleId}`;
      for (const permission of permissions) {
        // Denormalized tenantId stamp (unconditional — matches createRole's stamp;
        // nothing filters on RolePermission.tenantId while tenantEnforcing() is
        // false). Copies the owning Role's tenantId so the page's read gate can
        // filter RolePermission directly without a join.
        await tx.$executeRaw`
          INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
          VALUES (${roleId}, ${permission}, ${role.tenantId}) ON CONFLICT DO NOTHING
        `;
      }
      if (assignedUsers.length) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "sessionVersion" = "sessionVersion" + 1
          WHERE "id" = ANY(${assignedUsers.map((item) => item.userId)}::text[])
        `;
      }
      await logAuditStrict({
        action: "role.permissions_updated",
        summary: `Updated permissions for role “${role.name}”; affected sessions revoked`,
        entityType: "Role",
        entityId: roleId,
        user,
        before: { permissions: beforeKeys },
        after: { permissions },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings/access");
  });
}

export async function updateUserRoles(userId: string, formData: FormData) {
  return asActionResult(async () => {
    const actor = await requirePermission("roles.manage");
    await validUserId(userId);
    const requested = [...new Set(formData.getAll("roles").map(String))];
    const enforcing = tenantEnforcing();
    const activeTenantId = await getActiveTenantId();

    // Under enforcement: the target user must belong to the caller's active tenant.
    // Without this check a roles.manage holder can wipe role assignments for accounts
    // from other tenants by supplying a foreign userId directly.
    if (enforcing) {
      if (!activeTenantId) throw new ActionRefusal("No active tenant");
      const membership = await basePrisma.$queryRaw<Array<{ userId: string }>>`
        SELECT "userId" FROM "TenantMember"
        WHERE "tenantId" = ${activeTenantId} AND "userId" = ${userId}
        LIMIT 1
      `;
      if (!membership[0]) throw new ActionRefusal("User not found");
    }

    // Under enforcement a user may only be assigned a system role or one belonging
    // to their own tenant.
    const allRoles = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Role"
      WHERE (NOT ${enforcing}::boolean OR "tenantId" IS NULL OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
    `;
    const validRoleSet = new Set(allRoles.map((role) => role.id));
    const validRoleIds = requested.filter((roleId) => validRoleSet.has(roleId));

    // Under enforcement, read only this tenant's assignments for the "before" snapshot
    // so the audit log is accurate and other tenants' role assignments survive.
    const before = await basePrisma.$queryRaw<Array<{ roleId: string }>>`
      SELECT "roleId" FROM "UserRole"
      WHERE "userId" = ${userId}
        AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      ORDER BY "roleId"
    `;
    const targetRows = await basePrisma.$queryRaw<Array<{ role: string; disabledAt: Date | null }>>`
      SELECT "role", "disabledAt" FROM "User" WHERE "id" = ${userId} LIMIT 1
    `;
    const target = targetRows[0];
    if (!target) throw new ActionRefusal("User not found");

    const hadAdmin = target.role === "owner" || await roleIdsGrantAdmin(before.map((item) => item.roleId));
    const keepsAdmin = target.role === "owner" || await roleIdsGrantAdmin(validRoleIds);
    if (hadAdmin && !keepsAdmin && !target.disabledAt) {
      const remaining = await otherGovernanceAdminCount(activeTenantId, userId);
      if (remaining < 1) throw new ActionRefusal("This change would remove the last governance administrator");
    }

    // Under enforcement scope the DELETE to the active tenant so another tenant's
    // role assignments for the same user are left untouched.
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "UserRole"
        WHERE "userId" = ${userId}
          AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      `;
      for (const roleId of validRoleIds) {
        await tx.$executeRaw`
          INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES (gen_random_uuid()::text, ${userId}, ${roleId}, ${activeTenantId}) ON CONFLICT DO NOTHING
        `;
      }
      await tx.$executeRaw`
        UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE "id" = ${userId}
      `;
      await logAuditStrict({
        action: "user.roles_updated",
        summary: "Updated user roles; active sessions revoked",
        entityType: "User",
        entityId: userId,
        user: actor,
        before: { roles: before.map((item) => item.roleId) },
        after: { roles: validRoleIds },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings/access");
    revalidatePath("/settings");
    await bumpUserSessionVersion(actor.id).catch(() => {});
  });
}
