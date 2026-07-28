import Link from "next/link";
import { Plus, Lock, Activity, AlertTriangle } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { formatDateTime } from "@/lib/format";
import { parseModuleCsv } from "@/lib/modules/entitlement";
import { getPlatformHealth, type BackupHealth } from "@/lib/platformHealth";
import ModalTrigger from "@/components/Modal";
import { createTenantAction } from "@/app/actions/tenants";

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
  // A tenant id in the error list may name a tenant that has since been deleted;
  // fall back to the raw id rather than rendering a blank.
  const tenantName = (tenantId: string) =>
    tenants.find((tenant) => tenant.id === tenantId)?.name ?? tenantId;

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

      {/* ONE compact status strip. These were three stacked full-width panels that
          pushed the tenant list — the actual point of this page — below the fold.
          Standing facts belong in a glanceable row, not a wall of prose. */}
      <section className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium ${
            enforcing
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-amber-500/25 bg-amber-500/10 text-amber-200"
          }`}
          title={
            enforcing
              ? "Tenant isolation is enforced. Tenants can be activated."
              : "No cross-tenant data isolation yet. New tenants are created inert and cannot be activated — activating one now would expose existing data to it."
          }
        >
          <Lock className="size-3.5" />
          Isolation {enforcing ? "ON" : "OFF"}
        </span>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium ${BACKUP_TONE[health.backup.status]}`}
          title={
            health.backup.lastRunAt
              ? `Last run ${formatDateTime(health.backup.lastRunAt)}`
              : "No backup run has been recorded yet"
          }
        >
          <Activity className="size-3.5" />
          Backups: {BACKUP_LABEL[health.backup.status]}
        </span>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium ${
            health.errors.total24h > 0
              ? "border-red-500/25 bg-red-500/10 text-red-200"
              : "border-border text-muted-foreground"
          }`}
        >
          <AlertTriangle className="size-3.5" />
          {health.errors.total24h} error{health.errors.total24h === 1 ? "" : "s"} in 24h
        </span>

        {!enforcing && (
          <span className="text-muted-foreground">
            New tenants are created inert and cannot be activated until isolation is on.
          </span>
        )}
      </section>


      <section className="card p-0">
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-3">
          <h2 className="font-semibold">All tenants</h2>
          <span className="text-xs text-muted-foreground">{tenants.length} tenant{tenants.length === 1 ? "" : "s"}</span>
        </div>

        {tenants.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No tenants yet — create one above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-semibold">Tenant</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">Members</th>
                  <th className="px-3 py-2 text-right font-semibold">Modules</th>
                  <th className="px-3 py-2 text-right font-semibold">Errors 24h</th>
                  <th className="px-5 py-2 font-semibold">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {tenants.map((tenant) => {
                  const stats = health.tenants.get(tenant.id);
                  const granted = parseModuleCsv(tenant.modules);
                  const isFounding = tenant.id === DEFAULT_TENANT_ID;
                  const errors = stats?.errors24h ?? 0;
                  // An unhealthy tenant should be obvious from the row itself, not
                  // only from a number in one column: a left accent plus a tinted
                  // background, kept subtle so a busy day does not look like an
                  // emergency.
                  return (
                    <tr
                      key={tenant.id}
                      className={`transition-colors ${
                        errors > 0
                          ? "border-l-2 border-l-red-500/70 bg-red-500/[0.04] hover:bg-red-500/[0.07]"
                          : "hover:bg-white/[0.02]"
                      }`}
                    >
                      <td className="px-5 py-3">
                        <Link href={`/platform/tenants/${tenant.id}`} className="font-medium transition-colors hover:text-primary">
                          {tenant.name}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">/{tenant.slug}</span>
                        {isFounding && <span className="badge ml-2 bg-primary/15 text-primary">Founding</span>}
                        {errors > 0 && (
                          <span className="badge ml-2 inline-flex items-center gap-1 bg-red-500/15 text-red-300">
                            <AlertTriangle className="size-3" />
                            {errors} error{errors === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`badge ${tenant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                          {tenant.active ? "Active" : "Suspended"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{stats?.users ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{granted.size === 0 ? <span className="text-muted-foreground">core</span> : granted.size}</td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {errors > 0 ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-red-300">
                            <AlertTriangle className="size-3" />
                            {errors}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">
                        {stats?.lastActiveAt ? formatDateTime(stats.lastActiveAt) : "never"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Errors AFTER the tenant list. The strip above already says how many there
          are; this is the detail you scroll to, not the thing that displaces the
          page's purpose. Messages are clamped — an unhandled Prisma error can be a
          multi-thousand-character invocation dump, which as raw text buried the
          whole page. */}
      {health.errors.recent.length > 0 && (
        <details className="card group p-0">
          {/* COLLAPSED by default. The status strip at the top already reports the
              count, so this is the detail you open when you want it — an expanded
              wall of stack traces greeted every visit and buried the page. */}
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 select-none [&::-webkit-details-marker]:hidden">
            <h2 className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="size-4 text-red-300" />
              Recent errors
              <span className="text-xs font-normal text-muted-foreground">
                {health.errors.total24h} in 24h · last 7 days
              </span>
            </h2>
            <span className="btn-secondary btn-sm shrink-0 group-open:hidden">Show</span>
            <span className="btn-secondary btn-sm hidden shrink-0 group-open:inline-flex">Hide</span>
          </summary>

          <ul className="divide-y divide-border/50 border-t border-border/50">
            {health.errors.recent.map((error) => (
              <li key={error.id} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {error.scope}
                  </span>
                  {error.tenantId ? (
                    <Link
                      href={`/platform/tenants/${error.tenantId}`}
                      className="text-xs font-medium transition-colors hover:text-primary"
                    >
                      {tenantName(error.tenantId)}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">unattributed</span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatDateTime(error.createdAt)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 break-words text-xs text-foreground/80 [overflow-wrap:anywhere]">
                  {error.message}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}

    </div>
  );
}
