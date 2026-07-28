import { Plus, Lock, Activity } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { formatDateTime } from "@/lib/format";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { parseModuleCsv } from "@/lib/modules/entitlement";
import { getPlatformHealth, type BackupHealth } from "@/lib/platformHealth";
import ModalTrigger from "@/components/Modal";
import {
  createTenantAction,
  activateTenantAction,
  suspendTenantAction,
  addTenantMemberAction,
  removeTenantMemberAction,
  setTenantModulesAction,
} from "@/app/actions/tenants";

export const dynamic = "force-dynamic";

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  modules: string;
  createdAt: Date;
};
type MemberRow = { tenantId: string; userId: string; userName: string; userEmail: string; disabledAt: Date | null };
type UserRow = { id: string; name: string; email: string; disabledAt: Date | null };

/** Optional packs only — `core` is mandatory and never part of a grant. */
const OPTIONAL_MODULES = MODULE_REGISTRY.filter((module) => !module.mandatory);

const BACKUP_LABEL: Record<BackupHealth["status"], string> = {
  never: "No runs recorded",
  ok: "Healthy",
  degraded: "Succeeded with warnings",
  failed: "Last run FAILED",
  stuck: "A run started and never finished",
  overdue: "Overdue — no recent success",
};

const BACKUP_TONE: Record<BackupHealth["status"], string> = {
  never: "border-border text-muted-foreground",
  ok: "border-emerald-500/25 bg-emerald-500/10 text-emerald-200",
  degraded: "border-amber-500/25 bg-amber-500/10 text-amber-200",
  failed: "border-red-500/25 bg-red-500/10 text-red-200",
  stuck: "border-red-500/25 bg-red-500/10 text-red-200",
  overdue: "border-amber-500/25 bg-amber-500/10 text-amber-200",
};

export default async function PlatformTenantsPage() {
  // Defence-in-depth: the (console) layout already gates this route group, but
  // re-check here so the queries below can never run without a platform session.
  await requirePlatformAdmin();

  const enforcing = tenantEnforcing();

  const health = await getPlatformHealth();

  const [tenants, memberRows, users] = await Promise.all([
    basePrisma.$queryRaw<TenantRow[]>`
      SELECT "id", "name", "slug", "active", "modules", "createdAt" FROM "Tenant" ORDER BY "createdAt"
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

      {/* Platform health. Backups and errors are PLATFORM-WIDE facts, not per-tenant
          ones, and are shown as such rather than repeated under each tenant as if
          they were scoped. Per-tenant size/activity lives on the tenant rows below. */}
      <section className="card p-5">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Platform health</h2>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={`rounded-lg border p-3 ${BACKUP_TONE[health.backup.status]}`}>
            <p className="text-[10px] font-semibold uppercase tracking-wide opacity-80">Backups</p>
            <p className="mt-1 text-sm font-semibold">{BACKUP_LABEL[health.backup.status]}</p>
            <p className="mt-1 text-xs opacity-90">
              {health.backup.lastRunAt
                ? <>Last run {formatDateTime(health.backup.lastRunAt)}</>
                : <>No run has been recorded yet.</>}
              {health.backup.lastSuccessAt && health.backup.lastRunAt
                && health.backup.lastSuccessAt.getTime() !== health.backup.lastRunAt.getTime() && (
                <> · last success {formatDateTime(health.backup.lastSuccessAt)}</>
              )}
            </p>
            {health.backup.sizeBytes != null && (
              <p className="mt-0.5 text-xs opacity-75">
                {(health.backup.sizeBytes / 1024 / 1024).toFixed(1)} MB
                {health.backup.durationMs != null && <> · took {Math.round(health.backup.durationMs / 1000)}s</>}
              </p>
            )}
            {health.backup.recentFailures > 1 && (
              <p className="mt-1 text-xs font-medium">
                {health.backup.recentFailures} consecutive failures since the last success.
              </p>
            )}
            {health.backup.error && (
              <p className="mt-1 break-words text-xs opacity-90">{health.backup.error}</p>
            )}
            <p className="mt-2 text-[11px] opacity-70">
              Backups are platform-wide — one dump of the whole database, not per tenant.
            </p>
          </div>

          <div className="rounded-lg border border-border p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Unattributed errors
            </p>
            <p className="mt-1 text-sm font-semibold">
              {health.errors.unattributed24h} in 24h · {health.errors.unattributed7d} in 7d
            </p>
            {health.errors.topScopes.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {health.errors.topScopes.map((s) => (
                  <li key={s.scope}>{s.scope} · {s.count}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                No unattributed errors in the last 7 days.
              </p>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground/80">
              Errors with no tenant: webhooks, cron, pre-auth failures, and rows logged
              before attribution existed. Tenant-attributed errors appear on each tenant below.
            </p>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground/80">
          Per-tenant integration health is not shown: per-tenant integration credentials
          do not exist in this schema yet, so there is nothing to report.
        </p>
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
            // parseModuleCsv drops unknown ids, so a stale grant naming a removed
            // module never renders a phantom checkbox.
            const granted = parseModuleCsv(tenant.modules);
            const stats = health.tenants.get(tenant.id);
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
                      {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
                      {granted.size === 0
                        ? "core only"
                        : `${granted.size} module${granted.size === 1 ? "" : "s"}`}{" "}
                      · created {formatDateTime(tenant.createdAt)}
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

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Activity
                    </p>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                      <dt className="text-muted-foreground">Leads</dt>
                      <dd className="text-right tabular-nums">{stats?.leads ?? 0}</dd>
                      <dt className="text-muted-foreground">Contacts</dt>
                      <dd className="text-right tabular-nums">{stats?.contacts ?? 0}</dd>
                      <dt className="text-muted-foreground">Members</dt>
                      <dd className="text-right tabular-nums">{stats?.users ?? members.length}</dd>
                      <dt className={(stats?.errors24h ?? 0) > 0 ? "text-red-300" : "text-muted-foreground"}>
                        Errors (24h)
                      </dt>
                      <dd className={`text-right tabular-nums ${(stats?.errors24h ?? 0) > 0 ? "font-semibold text-red-300" : ""}`}>
                        {stats?.errors24h ?? 0}
                      </dd>
                      <dt className="text-muted-foreground">Errors (7d)</dt>
                      <dd className="text-right tabular-nums">{stats?.errors7d ?? 0}</dd>
                    </dl>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {stats?.lastActiveAt
                        ? <>Last staff activity {formatDateTime(stats.lastActiveAt)}</>
                        : <>No staff session recorded — this tenant has never been used.</>}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Modules
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      What this tenant may use. Their own admin can switch a granted
                      pack off, but can never switch on one that is not granted.
                      CRM core is always on.
                    </p>

                    <form action={setTenantModulesAction.bind(null, tenant.id)} className="mt-3">
                      <ul className="space-y-2">
                        {OPTIONAL_MODULES.map((module) => (
                          <li key={module.id} className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              id={`mod-${tenant.id}-${module.id}`}
                              name="modules"
                              value={module.id}
                              defaultChecked={granted.has(module.id)}
                              className="mt-0.5 shrink-0"
                            />
                            <label
                              htmlFor={`mod-${tenant.id}-${module.id}`}
                              className="min-w-0 flex-1 cursor-pointer"
                            >
                              <span className="block text-sm">{module.label}</span>
                              <span className="block text-xs text-muted-foreground">
                                {module.description}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <button className="btn-secondary btn-sm mt-3">Save modules</button>
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
