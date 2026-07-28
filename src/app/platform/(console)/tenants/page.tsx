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

      {/* Errors first, and only when there ARE any. A count buried behind a click
          cannot tell you something is wrong; this shows the actual failures, newest
          first, with the tenant that owns them. Silent when everything is healthy so
          it stays meaningful rather than becoming furniture. */}
      {health.errors.total24h > 0 && (
        <section className="card border-l-4 border-l-red-500 p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-red-500/10 text-red-300">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-red-200">
                {health.errors.total24h} error{health.errors.total24h === 1 ? "" : "s"} in the last 24 hours
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Most recent first. Full detail lives in each tenant&apos;s Settings → System Log.
              </p>

              <ul className="mt-3 divide-y divide-border/50">
                {health.errors.recent.map((error) => (
                  <li key={error.id} className="py-2 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {error.scope}
                      </span>
                      <span className="text-xs font-medium">
                        {error.tenantId
                          ? tenantName(error.tenantId)
                          : <span className="text-muted-foreground">unattributed</span>}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {formatDateTime(error.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 break-words text-xs text-foreground/80 [overflow-wrap:anywhere]">
                      {error.message}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Platform health. Backups are PLATFORM-WIDE facts, not per-tenant ones, and
          are shown as such rather than repeated under each tenant as if they were
          scoped. Per-tenant size/activity lives on the tenant rows below. */}
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
                  <th className="px-3 py-2 text-right font-semibold">Leads</th>
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
                  return (
                    <tr key={tenant.id} className="transition-colors hover:bg-white/[0.02]">
                      <td className="px-5 py-3">
                        <Link href={`/platform/tenants/${tenant.id}`} className="font-medium transition-colors hover:text-primary">
                          {tenant.name}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">/{tenant.slug}</span>
                        {isFounding && <span className="badge ml-2 bg-primary/15 text-primary">Founding</span>}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`badge ${tenant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                          {tenant.active ? "Active" : "Suspended"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{stats?.leads ?? 0}</td>
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
    </div>
  );
}
