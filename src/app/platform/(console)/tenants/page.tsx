import { redirect } from "next/navigation";
import { Plus, ShieldAlert, Lock } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/tenantAdmin";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { formatDateTime } from "@/lib/format";
import ModalTrigger from "@/components/Modal";
import {
  createTenantAction,
  activateTenantAction,
  suspendTenantAction,
  addTenantMemberAction,
  removeTenantMemberAction,
} from "@/app/actions/tenants";

export const dynamic = "force-dynamic";

type TenantRow = { id: string; name: string; slug: string; active: boolean; createdAt: Date };
type MemberRow = { tenantId: string; userId: string; userName: string; userEmail: string; disabledAt: Date | null };
type UserRow = { id: string; name: string; email: string; disabledAt: Date | null };

export default async function PlatformTenantsPage() {
  // Defence-in-depth: the layout gates the whole area, but re-check here so the
  // queries below never run for a non-owner who reaches the page component.
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");
  if (!isPlatformAdmin(currentUser.role)) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-red-500/20 bg-red-500/10 text-red-400">
          <ShieldAlert className="size-6" />
        </span>
        <h1 className="text-lg font-semibold">Not authorized</h1>
        <p className="mt-2 text-sm text-muted-foreground">Tenant management is restricted to platform owners.</p>
      </div>
    );
  }

  const enforcing = tenantEnforcing();

  const [tenants, memberRows, users] = await Promise.all([
    basePrisma.$queryRaw<TenantRow[]>`
      SELECT "id", "name", "slug", "active", "createdAt" FROM "Tenant" ORDER BY "createdAt"
    `,
    basePrisma.$queryRaw<MemberRow[]>`
      SELECT tm."tenantId", tm."userId", u."name" AS "userName", u."email" AS "userEmail", u."disabledAt"
      FROM "TenantMember" tm JOIN "User" u ON u."id" = tm."userId"
      ORDER BY u."name"
    `,
    basePrisma.$queryRaw<UserRow[]>`
      SELECT "id", "name", "email", "disabledAt" FROM "User" ORDER BY "name"
    `,
  ]);

  const membersFor = (tenantId: string) => memberRows.filter((row) => row.tenantId === tenantId);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Tenant management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Provision, activate and staff tenants across the platform.
          </p>
        </div>
        <ModalTrigger
          label={<><Plus className="size-4" />Create tenant</>}
          title="Create tenant"
          buttonClass="btn-primary btn-sm inline-flex items-center gap-1.5"
        >
          <form action={createTenantAction} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Tenant name</label>
                <input name="name" className="input" required autoFocus placeholder="e.g. Denago Johannesburg" />
              </div>
              <div>
                <label className="label">Slug</label>
                <input name="slug" className="input" required placeholder="denago-jhb" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
                <p className="mt-1 text-xs text-muted-foreground">Lowercase letters, numbers and hyphens. Must be unique.</p>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Owner account</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label">Owner name</label>
                  <input name="ownerName" className="input" required placeholder="Full name" />
                </div>
                <div>
                  <label className="label">Owner email</label>
                  <input name="ownerEmail" type="email" className="input" required placeholder="owner@example.com" />
                </div>
              </div>
              <div>
                <label className="label">Temporary password</label>
                <input name="ownerPassword" type="password" className="input" required minLength={12} placeholder="At least 12 characters" />
                <p className="mt-1 text-xs text-muted-foreground">At least 12 characters, including letters and numbers.</p>
              </div>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200/90">
              New tenants are created <strong>inert</strong>: suspended, with the owner disabled and no modules. They cannot sign in until you activate them — which is blocked until tenant isolation enforcement is on.
            </div>
            <button className="btn-primary w-full">Create tenant</button>
          </form>
        </ModalTrigger>
      </div>

      {/* Prominent safety banner: the inert-until-isolation-on model. */}
      <section className={`card p-4 border-l-4 ${enforcing ? "border-l-emerald-500" : "border-l-amber-500"}`}>
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${enforcing ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>
            <Lock className="size-4" />
          </span>
          <div className="text-sm">
            <p className="font-semibold">
              Isolation enforcement is {enforcing ? "ON" : "OFF"}.
            </p>
            <p className="mt-1 text-muted-foreground">
              There is no cross-tenant data isolation until enforcement is enabled. New tenants are therefore created
              <strong className="text-foreground"> inert</strong> (suspended, owner disabled, no modules) so their credentials
              cannot reach the currently-unscoped CRM. {enforcing
                ? "Enforcement is on, so tenants can now be activated."
                : "Activation is disabled until enforcement is turned on — activating now would expose existing data to a new tenant."}
            </p>
          </div>
        </div>
      </section>

      <section className="card p-0 divide-y divide-border/50">
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="font-semibold">All tenants</h2>
          <span className="text-xs text-muted-foreground">{tenants.length} tenant{tenants.length === 1 ? "" : "s"}</span>
        </div>

        {tenants.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No tenants yet — create one above.</p>
        ) : (
          tenants.map((tenant) => {
            const members = membersFor(tenant.id);
            const isFounding = tenant.id === DEFAULT_TENANT_ID;
            const addable = users.filter((u) => !members.some((m) => m.userId === u.id));
            return (
              <details key={tenant.id}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {tenant.name}
                    <span className="text-xs font-normal text-muted-foreground">/{tenant.slug}</span>
                    <span className={`badge ${tenant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                      {tenant.active ? "Active" : "Suspended"}
                    </span>
                    {isFounding && <span className="badge bg-primary/15 text-primary">Founding</span>}
                    <span className="text-xs font-normal text-muted-foreground">
                      {members.length} member{members.length === 1 ? "" : "s"} · created {formatDateTime(tenant.createdAt)}
                    </span>
                  </span>
                  <span className="btn-secondary btn-sm shrink-0">Manage</span>
                </summary>

                <div className="space-y-5 px-5 pb-5">
                  {/* Activate / suspend controls */}
                  <div className="flex flex-wrap items-center gap-3">
                    {tenant.active ? (
                      isFounding ? (
                        <div>
                          <button className="btn-secondary btn-sm" disabled>Suspend</button>
                          <p className="mt-1 text-xs text-muted-foreground">The founding tenant cannot be suspended.</p>
                        </div>
                      ) : (
                        <form action={suspendTenantAction.bind(null, tenant.id)}>
                          <button className="btn-danger btn-sm">Suspend</button>
                        </form>
                      )
                    ) : enforcing ? (
                      <form action={activateTenantAction.bind(null, tenant.id)}>
                        <button className="btn-primary btn-sm">Activate</button>
                      </form>
                    ) : (
                      <div>
                        <button className="btn-secondary btn-sm" disabled title="Enable tenant isolation enforcement first">
                          Activate
                        </button>
                        <p className="mt-1 max-w-md text-xs text-amber-300/90">
                          Activation is disabled until tenant isolation enforcement is enabled — activating now would expose existing data.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Members */}
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Members</p>
                    <ul className="divide-y divide-border/50">
                      {members.length === 0 && <li className="py-2 text-xs text-muted-foreground">No members.</li>}
                      {members.map((member) => (
                        <li key={member.userId} className="flex items-center gap-2 py-2 text-sm">
                          <span className="flex-1">
                            {member.userName}
                            <span className="ml-2 text-xs text-muted-foreground">{member.userEmail}</span>
                            {member.disabledAt && <span className="ml-2 text-xs text-red-400">Disabled</span>}
                          </span>
                          {members.length > 1 ? (
                            <form action={removeTenantMemberAction.bind(null, tenant.id, member.userId)}>
                              <button className="text-xs text-red-400 hover:text-red-300">Remove</button>
                            </form>
                          ) : (
                            <span className="text-xs text-muted-foreground" title="A tenant must keep at least one member">Last member</span>
                          )}
                        </li>
                      ))}
                    </ul>

                    <form action={addTenantMemberAction.bind(null, tenant.id)} className="mt-3 flex gap-2">
                      <select name="userId" className="input flex-1" required defaultValue="">
                        <option value="" disabled>Add a member…</option>
                        {addable.map((u) => (
                          <option key={u.id} value={u.id}>{u.name} — {u.email}</option>
                        ))}
                      </select>
                      <button className="btn-secondary btn-sm" disabled={addable.length === 0}>Add</button>
                    </form>
                  </div>
                </div>
              </details>
            );
          })
        )}
      </section>
    </div>
  );
}
