import { Plus } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import {
  createRole,
  createTeam,
  addTeamMember,
  removeTeamMember,
  updateRolePermissions,
  updateTeam,
  updateUserRoles,
} from "@/app/actions/accessControl";
import { revokeUserSessions, setUserDisabled } from "@/app/actions/security";
import { formatDateTime } from "@/lib/format";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";

export const dynamic = "force-dynamic";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  failedLoginCount: number;
};
type TeamRow = { id: string; name: string; description: string | null; active: boolean; managerId: string | null };
type TeamMemberRow = { teamId: string; userId: string; userName: string; isManager: boolean };
type RoleRow = { id: string; name: string; description: string | null; system: boolean };
type PermissionRow = { key: string; description: string; category: string };
type RolePermissionRow = { roleId: string; permissionKey: string };
type UserRoleRow = { userId: string; roleId: string };

export default async function AccessSettingsPage() {
  const currentUser = await requireAnyPermission("teams.view", "roles.view");
  const [canViewTeams, canManageTeams, canViewRoles, canManageRoles] = await Promise.all([
    hasPermission(currentUser, "teams.view"),
    hasPermission(currentUser, "teams.manage"),
    hasPermission(currentUser, "roles.view"),
    hasPermission(currentUser, "roles.manage"),
  ]);
  const canManageSecurity = currentUser.role === "owner";

  // Multi-tenancy readiness: Team/TeamMember already carry tenantId (stamped on
  // create), but these reads only ever filtered by id/deletedAt. The
  // `NOT enforcing OR ...` clause keeps this dormant (byte-for-byte today's
  // query) until tenantEnforcing() flips on.
  const enforcing = tenantEnforcing();
  const activeTenantId = await getActiveTenantId();

  const users = await basePrisma.$queryRaw<UserRow[]>`
    SELECT "id", "name", "email", "role", "disabledAt", "lastLoginAt", "failedLoginCount"
    FROM "User"
    ORDER BY "disabledAt" NULLS FIRST, "name"
  `;
  const teams = canViewTeams
    ? await basePrisma.$queryRaw<TeamRow[]>`
        SELECT "id", "name", "description", "active", "managerId"
        FROM "Team"
        WHERE "deletedAt" IS NULL
          AND (NOT ${enforcing}::boolean OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
        ORDER BY "name"
      `
    : [];
  const members = canViewTeams
    ? await basePrisma.$queryRaw<TeamMemberRow[]>`
        SELECT tm."teamId", tm."userId", u."name" AS "userName", tm."isManager"
        FROM "TeamMember" tm JOIN "User" u ON u."id" = tm."userId"
        WHERE (NOT ${enforcing}::boolean OR tm."tenantId" IS NOT DISTINCT FROM ${activeTenantId})
        ORDER BY u."name"
      `
    : [];
  // Multi-tenancy readiness: Role/RolePermission now carry tenantId (NULL =
  // system/global, non-null = one tenant's own custom role); UserRole already
  // did. Under enforcement, only system-global rows or the viewer's own
  // tenant's rows should be visible. The `NOT enforcing OR ...` clause keeps
  // this dormant (byte-for-byte today's query) until tenantEnforcing() flips
  // on. Permission (the fixed capability catalog) has no tenantId and is
  // unaffected.
  const roles = canViewRoles
    ? await basePrisma.$queryRaw<RoleRow[]>`
        SELECT "id", "name", "description", "system" FROM "Role"
        WHERE (NOT ${enforcing}::boolean OR "tenantId" IS NULL OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
        ORDER BY "system" DESC, "name"
      `
    : [];
  const permissions = canViewRoles
    ? await basePrisma.$queryRaw<PermissionRow[]>`
        SELECT "key", "description", "category" FROM "Permission" ORDER BY "category", "key"
      `
    : [];
  const rolePermissions = canViewRoles
    ? await basePrisma.$queryRaw<RolePermissionRow[]>`
        SELECT "roleId", "permissionKey" FROM "RolePermission"
        WHERE (NOT ${enforcing}::boolean OR "tenantId" IS NULL OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      `
    : [];
  const userRoles = canViewRoles
    ? await basePrisma.$queryRaw<UserRoleRow[]>`
        SELECT "userId", "roleId" FROM "UserRole"
        WHERE (NOT ${enforcing}::boolean OR "tenantId" IS NULL OR "tenantId" IS NOT DISTINCT FROM ${activeTenantId})
      `
    : [];

  const membersFor = (teamId: string) => members.filter((member) => member.teamId === teamId);
  const rolePermissionSet = new Set(rolePermissions.map((item) => `${item.roleId}:${item.permissionKey}`));
  const userRoleSet = new Set(userRoles.map((item) => `${item.userId}:${item.roleId}`));
  const categories = [...new Set(permissions.map((permission) => permission.category))];

  const managerName = (id: string | null) =>
    id ? users.find((u) => u.id === id)?.name ?? "None" : "None";

  return (
    <SettingsWorkspace
      current="team"
      title="Teams, roles & permissions"
      description="Granular access, team ownership, session revocation and user lifecycle controls."
      groups={SETTINGS_NAV_GROUPS}
    >

      {canManageSecurity && (
        <section className="card p-0 overflow-x-auto">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">User security</h2>
            <p className="text-xs text-muted-foreground mt-1">Disabling a user or revoking sessions takes effect on their next request.</p>
          </div>
          <table className="table-base">
            <thead><tr><th>User</th><th>Status</th><th>Last login</th><th>Failed logins</th><th></th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}<p className="text-xs text-muted-foreground">{user.email}</p></td>
                  <td>
                    <span className={`badge ${user.disabledAt ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                      {user.disabledAt ? "Disabled" : "Active"}
                    </span>
                    {user.role === "owner" && <span className="badge bg-primary/15 text-primary ml-2">Owner</span>}
                  </td>
                  <td className="text-sm text-muted-foreground">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never"}</td>
                  <td>{user.failedLoginCount}</td>
                  <td>
                    {user.id !== currentUser.id && (
                      <div className="flex gap-2 justify-end">
                        <form action={revokeUserSessions.bind(null, user.id)}>
                          <button className="btn-secondary btn-sm">Revoke sessions</button>
                        </form>
                        <form action={setUserDisabled.bind(null, user.id, !user.disabledAt)}>
                          <button className={user.disabledAt ? "btn-secondary btn-sm" : "btn-danger btn-sm"}>
                            {user.disabledAt ? "Reactivate" : "Disable"}
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {canViewTeams && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Teams</h2>
              <p className="text-xs text-muted-foreground">Group members for team-level lead visibility and ownership.</p>
            </div>
            {canManageTeams && (
              <ModalTrigger
                label={<><Plus className="size-4" />Create team</>}
                title="Create team"
                buttonClass={buttonVariants({ size: "sm" })}
              >
                <form action={createTeam} className="space-y-4">
                  <div>
                    <label className="label">Name</label>
                    <input name="name" className="input" required autoFocus placeholder="e.g. Sales floor" />
                  </div>
                  <div>
                    <label className="label">Manager</label>
                    <select name="managerId" className="input" defaultValue="">
                      <option value="">No manager</option>
                      {users.filter((u) => !u.disabledAt).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Description</label>
                    <input name="description" className="input" placeholder="Optional" />
                  </div>
                  <button className="btn-primary w-full">Create team</button>
                </form>
              </ModalTrigger>
            )}
          </div>

          <div className="card p-0 divide-y divide-border/50">
            {teams.length === 0 ? (
              <p className="text-sm text-muted-foreground p-5">No teams yet{canManageTeams ? " — create one above." : "."}</p>
            ) : (
              teams.map((team) => (
                <details key={team.id}>
                  <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                    <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {team.name}
                      {!team.active && <span className="badge bg-muted text-muted-foreground">Inactive</span>}
                      <span className="text-xs font-normal text-muted-foreground">
                        {membersFor(team.id).length} member{membersFor(team.id).length === 1 ? "" : "s"} · manager: {managerName(team.managerId)}
                      </span>
                    </span>
                    <span className="btn-secondary btn-sm shrink-0">{canManageTeams ? "Manage" : "View"}</span>
                  </summary>
                  <div className="px-5 pb-5 space-y-4">
                    {canManageTeams && (
                      <form action={updateTeam.bind(null, team.id)} className="grid sm:grid-cols-2 gap-2">
                        <input name="name" className="input" defaultValue={team.name} required />
                        <select name="managerId" className="input" defaultValue={team.managerId ?? ""}>
                          <option value="">No manager</option>
                          {users.filter((u) => !u.disabledAt).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <input name="description" className="input sm:col-span-2" defaultValue={team.description ?? ""} placeholder="Description" />
                        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" name="active" defaultChecked={team.active} className="h-4 w-4" /> Active</label>
                        <div className="sm:text-right"><button className="btn-secondary btn-sm">Save team</button></div>
                      </form>
                    )}
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Members</p>
                      <ul className="divide-y divide-border/50">
                        {membersFor(team.id).length === 0 && <li className="py-2 text-xs text-muted-foreground">No members yet.</li>}
                        {membersFor(team.id).map((member) => (
                          <li key={member.userId} className="py-2 flex items-center gap-2 text-sm">
                            <span className="flex-1">{member.userName}{member.isManager && <span className="text-xs text-primary ml-2">Manager</span>}</span>
                            {canManageTeams && <form action={removeTeamMember.bind(null, team.id, member.userId)}><button className="text-xs text-red-400 hover:text-red-300">Remove</button></form>}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {canManageTeams && (
                      <form action={addTeamMember.bind(null, team.id)} className="flex gap-2">
                        <select name="userId" className="input flex-1" required defaultValue="">
                          <option value="" disabled>Add member…</option>
                          {users.filter((c) => !c.disabledAt && !membersFor(team.id).some((m) => m.userId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button className="btn-secondary btn-sm">Add</button>
                      </form>
                    )}
                  </div>
                </details>
              ))
            )}
          </div>
        </section>
      )}

      {canViewRoles && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Roles &amp; permissions</h2>
              <p className="text-xs text-muted-foreground">Bundle permissions into roles, then assign roles to people.</p>
            </div>
            {canManageRoles && (
              <ModalTrigger
                label={<><Plus className="size-4" />Create role</>}
                title="Create role"
                buttonClass={buttonVariants({ size: "sm" })}
              >
                <form action={createRole} className="space-y-4">
                  <div>
                    <label className="label">Role name</label>
                    <input name="name" className="input" required autoFocus placeholder="e.g. Sales manager" />
                  </div>
                  <div>
                    <label className="label">Description</label>
                    <input name="description" className="input" placeholder="Optional" />
                  </div>
                  <button className="btn-primary w-full">Create role</button>
                </form>
              </ModalTrigger>
            )}
          </div>

          <div className="card p-0 divide-y divide-border/50">
            {roles.map((role) => {
              const count = permissions.filter((p) => rolePermissionSet.has(`${role.id}:${p.key}`)).length;
              return (
                <details key={role.id}>
                  <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                    <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {role.name}
                      {role.system ? (
                        <span className="badge bg-muted text-muted-foreground">System</span>
                      ) : (
                        <span className="badge bg-muted text-muted-foreground">Custom</span>
                      )}
                      <span className="text-xs font-normal text-muted-foreground">
                        {count} permission{count === 1 ? "" : "s"}{role.description ? ` · ${role.description}` : ""}
                      </span>
                    </span>
                    <span className="btn-secondary btn-sm shrink-0">{canManageRoles ? "Edit" : "View"}</span>
                  </summary>
                  <div className="px-5 pb-5">
                    <form action={updateRolePermissions.bind(null, role.id)} className="space-y-4">
                      {categories.map((category) => (
                        <div key={category}>
                          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">{category}</p>
                          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
                            {permissions.filter((p) => p.category === category).map((permission) => (
                              <label key={permission.key} className="rounded-lg border border-border bg-muted/30 p-2 flex gap-2 text-sm">
                                <input type="checkbox" name="permissions" value={permission.key} defaultChecked={rolePermissionSet.has(`${role.id}:${permission.key}`)} disabled={!canManageRoles} className="h-4 w-4 mt-0.5" />
                                <span><strong className="font-medium">{permission.key}</strong><span className="block text-xs text-muted-foreground">{permission.description}</span></span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                      {canManageRoles && <button className="btn-secondary btn-sm">Save permissions</button>}
                    </form>
                  </div>
                </details>
              );
            })}
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">Role assignments</p>
            <div className="card p-0 overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>User</th><th>Assigned roles</th></tr></thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>{user.name}<p className="text-xs text-muted-foreground">{user.email}</p>{user.disabledAt && <span className="text-xs text-red-400">Disabled</span>}</td>
                      <td>
                        <form action={updateUserRoles.bind(null, user.id)} className="flex flex-wrap gap-3 items-center">
                          {roles.map((role) => <label key={role.id} className="text-xs flex items-center gap-1"><input type="checkbox" name="roles" value={role.id} defaultChecked={userRoleSet.has(`${user.id}:${role.id}`)} disabled={!canManageRoles} className="h-3.5 w-3.5" /> {role.name}</label>)}
                          {canManageRoles && <button className="btn-secondary btn-sm">Save</button>}
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </SettingsWorkspace>
  );
}
