import { basePrisma } from "@/lib/db";
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

export const dynamic = "force-dynamic";

type UserRow = { id: string; name: string; email: string };
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

  const users = await basePrisma.$queryRaw<UserRow[]>`
    SELECT "id", "name", "email" FROM "User" ORDER BY "name"
  `;
  const teams = canViewTeams
    ? await basePrisma.$queryRaw<TeamRow[]>`
        SELECT "id", "name", "description", "active", "managerId"
        FROM "Team" WHERE "deletedAt" IS NULL ORDER BY "name"
      `
    : [];
  const members = canViewTeams
    ? await basePrisma.$queryRaw<TeamMemberRow[]>`
        SELECT tm."teamId", tm."userId", u."name" AS "userName", tm."isManager"
        FROM "TeamMember" tm JOIN "User" u ON u."id" = tm."userId"
        ORDER BY u."name"
      `
    : [];
  const roles = canViewRoles
    ? await basePrisma.$queryRaw<RoleRow[]>`
        SELECT "id", "name", "description", "system" FROM "Role" ORDER BY "system" DESC, "name"
      `
    : [];
  const permissions = canViewRoles
    ? await basePrisma.$queryRaw<PermissionRow[]>`
        SELECT "key", "description", "category" FROM "Permission" ORDER BY "category", "key"
      `
    : [];
  const rolePermissions = canViewRoles
    ? await basePrisma.$queryRaw<RolePermissionRow[]>`SELECT "roleId", "permissionKey" FROM "RolePermission"`
    : [];
  const userRoles = canViewRoles
    ? await basePrisma.$queryRaw<UserRoleRow[]>`SELECT "userId", "roleId" FROM "UserRole"`
    : [];

  const membersFor = (teamId: string) => members.filter((member) => member.teamId === teamId);
  const rolePermissionSet = new Set(rolePermissions.map((item) => `${item.roleId}:${item.permissionKey}`));
  const userRoleSet = new Set(userRoles.map((item) => `${item.userId}:${item.roleId}`));
  const categories = [...new Set(permissions.map((permission) => permission.category))];

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">Teams, roles and permissions</h1>
        <p className="text-sm text-slate-400 mt-1">
          Control team ownership and granular access while preserving the legacy owner safety override.
        </p>
      </div>

      {canViewTeams && (
        <>
          {canManageTeams && (
            <section className="card space-y-4">
              <h2 className="font-semibold">Create team</h2>
              <form action={createTeam} className="grid md:grid-cols-4 gap-3 items-end">
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Name</span>
                  <input name="name" className="input" required />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Manager</span>
                  <select name="managerId" className="input">
                    <option value="">No manager</option>
                    {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Description</span>
                  <input name="description" className="input" />
                </label>
                <button className="btn-primary">Create</button>
              </form>
            </section>
          )}

          <div className="grid lg:grid-cols-2 gap-4">
            {teams.map((team) => (
              <section key={team.id} className="card space-y-4">
                <div>
                  <h2 className="font-semibold">{team.name}</h2>
                  <p className="text-xs text-slate-500">{team.description || "No description"}</p>
                  {!team.active && <span className="badge bg-slate-800 text-slate-400 mt-2">Inactive</span>}
                </div>

                {canManageTeams ? (
                  <form action={updateTeam.bind(null, team.id)} className="grid grid-cols-2 gap-2">
                    <input name="name" className="input" defaultValue={team.name} required />
                    <select name="managerId" className="input" defaultValue={team.managerId ?? ""}>
                      <option value="">No manager</option>
                      {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                    </select>
                    <input name="description" className="input col-span-2" defaultValue={team.description ?? ""} />
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="active" defaultChecked={team.active} /> Active
                    </label>
                    <button className="btn-secondary">Save team</button>
                  </form>
                ) : (
                  <p className="text-xs text-slate-500">Manager: {users.find((user) => user.id === team.managerId)?.name ?? "None"}</p>
                )}

                <ul className="divide-y divide-slate-800">
                  {membersFor(team.id).map((member) => (
                    <li key={member.userId} className="py-2 flex items-center gap-2 text-sm">
                      <span className="flex-1">
                        {member.userName}
                        {member.isManager && <span className="text-xs text-orange-400 ml-2">Manager</span>}
                      </span>
                      {canManageTeams && (
                        <form action={removeTeamMember.bind(null, team.id, member.userId)}>
                          <button className="text-xs text-red-400">Remove</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>

                {canManageTeams && (
                  <form action={addTeamMember.bind(null, team.id)} className="flex gap-2">
                    <select name="userId" className="input">
                      <option value="">Add member…</option>
                      {users
                        .filter((user) => !membersFor(team.id).some((member) => member.userId === user.id))
                        .map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                    </select>
                    <button className="btn-secondary">Add</button>
                  </form>
                )}
              </section>
            ))}
          </div>
        </>
      )}

      {canViewRoles && (
        <>
          {canManageRoles && (
            <section className="card">
              <h2 className="font-semibold mb-4">Create role</h2>
              <form action={createRole} className="grid md:grid-cols-3 gap-3 items-end">
                <input name="name" className="input" placeholder="Role name" required />
                <input name="description" className="input" placeholder="Description" />
                <button className="btn-primary">Create role</button>
              </form>
            </section>
          )}

          <div className="space-y-4">
            {roles.map((role) => (
              <section key={role.id} className="card">
                <div className="mb-4">
                  <h2 className="font-semibold">
                    {role.name}
                    {role.system && <span className="badge bg-slate-800 text-slate-300 ml-2">System</span>}
                  </h2>
                  <p className="text-xs text-slate-500">{role.description}</p>
                </div>
                <form action={updateRolePermissions.bind(null, role.id)} className="space-y-4">
                  {categories.map((category) => (
                    <div key={category}>
                      <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">{category}</p>
                      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
                        {permissions.filter((permission) => permission.category === category).map((permission) => (
                          <label key={permission.key} className="rounded border border-slate-800 p-2 flex gap-2 text-sm">
                            <input
                              type="checkbox"
                              name="permissions"
                              value={permission.key}
                              defaultChecked={rolePermissionSet.has(`${role.id}:${permission.key}`)}
                              disabled={!canManageRoles}
                            />
                            <span>
                              <strong>{permission.key}</strong>
                              <span className="block text-xs text-slate-500">{permission.description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  {canManageRoles && <button className="btn-secondary">Save permissions</button>}
                </form>
              </section>
            ))}
          </div>

          <section className="card p-0 overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>User</th><th>Assigned roles</th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.name}<p className="text-xs text-slate-500">{user.email}</p></td>
                    <td>
                      <form action={updateUserRoles.bind(null, user.id)} className="flex flex-wrap gap-3 items-center">
                        {roles.map((role) => (
                          <label key={role.id} className="text-xs flex gap-1">
                            <input
                              type="checkbox"
                              name="roles"
                              value={role.id}
                              defaultChecked={userRoleSet.has(`${user.id}:${role.id}`)}
                              disabled={!canManageRoles}
                            /> {role.name}
                          </label>
                        ))}
                        {canManageRoles && <button className="btn-secondary btn-sm">Save</button>}
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
