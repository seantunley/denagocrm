import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Mail,
  MessageSquare,
  Smartphone,
} from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { formatDateTime } from "@/lib/format";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { parseModuleCsv } from "@/lib/modules/entitlement";
import {
  getTenantIntegrationHealth,
  integrationVerdict,
  type IntegrationId,
  type IntegrationStatus,
} from "@/lib/integrationHealth";
import {
  getTenantStorage,
  getTenantActivity,
  formatBytes,
} from "@/lib/tenantUsage";
import Tabs from "@/components/Tabs";
import ModalTrigger from "@/components/Modal";
import {
  activateTenantAction,
  suspendTenantAction,
  addTenantMemberAction,
  removeTenantMemberAction,
  setTenantModulesAction,
} from "@/app/actions/tenants";

export const dynamic = "force-dynamic";

const OPTIONAL_MODULES = MODULE_REGISTRY.filter((module) => !module.mandatory);

const INTEGRATION_ICON: Record<IntegrationId, typeof Mail> = {
  email: Mail,
  whatsapp: MessageSquare,
  sms: Smartphone,
};

function IntegrationCard({ status }: { status: IntegrationStatus }) {
  const verdict = integrationVerdict(status);
  const Icon = INTEGRATION_ICON[status.id];

  const tone =
    verdict === "failing"
      ? "border-red-500/25 bg-red-500/10 text-red-200"
      : verdict === "ok"
        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
        : "border-border bg-muted/20 text-muted-foreground";

  const headline =
    verdict === "failing"
      ? `${status.errors7d} error${status.errors7d === 1 ? "" : "s"} in 7 days`
      : verdict === "ok"
        ? "Configured"
        : "Not configured";

  const VerdictIcon =
    verdict === "failing" ? AlertTriangle : verdict === "ok" ? CheckCircle2 : CircleSlash;

  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <p className="text-sm font-semibold">{status.label}</p>
        <VerdictIcon className="ml-auto size-4 shrink-0" />
      </div>
      <p className="mt-1 text-xs font-medium">{headline}</p>

      {/* Configured AND failing is the case a configured-only view would hide. */}
      {verdict === "failing" && !status.configured && (
        <p className="mt-1 text-[11px] opacity-90">Credentials are also missing.</p>
      )}
      {status.lastError && (
        <p className="mt-1.5 break-words text-[11px] opacity-90 [overflow-wrap:anywhere]">
          {status.lastError.message}
          <span className="block opacity-70">{formatDateTime(status.lastError.createdAt)}</span>
        </p>
      )}
    </div>
  );
}

export default async function TenantProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;

  const tenant = await basePrisma.tenant.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, active: true, modules: true, createdAt: true },
  });
  if (!tenant) notFound();

  const since24h = new Date(Date.now() - 24 * 3600_000);
  const since7d = new Date(Date.now() - 7 * 24 * 3600_000);

  const [members, addableUsers, leads, contacts, lastSession, errors, integrations] =
    await Promise.all([
      basePrisma.tenantMember.findMany({
        where: { tenantId: id },
        select: { userId: true, user: { select: { name: true, email: true } } },
      }),
      // A user already in ANY tenant cannot be added to a second one — sign-in
      // requires exactly one membership — so only offer the genuinely addable.
      basePrisma.user.findMany({
        where: { memberships: { none: {} } },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      }),
      basePrisma.lead.count({ where: { tenantId: id, deletedAt: null } }),
      basePrisma.contact.count({ where: { tenantId: id, deletedAt: null } }),
      basePrisma.userSession.findFirst({
        where: { tenantId: id },
        orderBy: { lastActiveAt: "desc" },
        select: { lastActiveAt: true },
      }),
      basePrisma.errorLog.findMany({
        where: { tenantId: id, createdAt: { gte: since7d } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, scope: true, message: true, context: true, createdAt: true },
      }),
      getTenantIntegrationHealth(id),
    ]);

  // Sequential and after the rest: the storage estimate runs a count per sampled
  // table, so it is the most expensive thing on this page.
  const [storage, activity] = await Promise.all([
    getTenantStorage(id),
    getTenantActivity(id),
  ]);

  const granted = parseModuleCsv(tenant.modules);
  const errors24h = errors.filter((error) => error.createdAt >= since24h).length;
  const isFounding = tenant.id === DEFAULT_TENANT_ID;
  const failingIntegrations = integrations.filter(
    (status) => integrationVerdict(status) === "failing",
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/platform/tenants"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All tenants
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-[-0.02em]">
              {tenant.name}
              <span
                className={`badge ${tenant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}
              >
                {tenant.active ? "Active" : "Suspended"}
              </span>
              {isFounding && <span className="badge bg-primary/15 text-primary">Founding</span>}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              /{tenant.slug} · created {formatDateTime(tenant.createdAt)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {tenant.active ? (
              !isFounding && (
                <form action={suspendTenantAction.bind(null, tenant.id)}>
                  <button className="btn-secondary btn-sm">Suspend</button>
                </form>
              )
            ) : (
              <form action={activateTenantAction.bind(null, tenant.id)}>
                <button className="btn-primary btn-sm" disabled={!tenantEnforcing()}>
                  Activate
                </button>
              </form>
            )}
          </div>
        </div>

        {!tenant.active && !tenantEnforcing() && (
          <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/90">
            Activation is blocked until tenant isolation enforcement is on — activating now
            would expose existing data to this tenant.
          </p>
        )}
      </div>

      {/* At-a-glance figures, visible on every tab rather than hidden inside one. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: "Leads", value: leads },
          { label: "Contacts", value: contacts },
          { label: "Members", value: members.length },
          { label: "Modules", value: granted.size },
        ].map((stat) => (
          <div key={stat.label} className="card p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {stat.label}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{stat.value}</p>
          </div>
        ))}
        <div className={`card p-3 ${errors24h > 0 ? "border-red-500/30" : ""}`}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Errors 24h
          </p>
          <p
            className={`mt-1 text-xl font-semibold tabular-nums ${errors24h > 0 ? "text-red-300" : ""}`}
          >
            {errors24h}
          </p>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Last staff activity:{" "}
        {lastSession?.lastActiveAt ? formatDateTime(lastSession.lastActiveAt) : "never signed in"}
      </p>

      <Tabs
        tabs={[
          {
            key: "integrations",
            label: "Integrations",
            count: failingIntegrations,
            content: (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  {integrations.map((status) => (
                    <IntegrationCard key={status.id} status={status} />
                  ))}
                </div>
                {!tenantEnforcing() && (
                  <p className="text-[11px] text-muted-foreground/80">
                    While isolation enforcement is off, integration settings are install-wide,
                    so every tenant reads the same credentials — the “configured” state will be
                    identical across tenants until enforcement is on. Error counts are already
                    per-tenant.
                  </p>
                )}
              </div>
            ),
          },
          {
            key: "usage",
            label: "Usage",
            content: (
              <div className="space-y-4">
                <div className="card p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold">Estimated database storage</h3>
                    <p className="text-2xl font-semibold tabular-nums">
                      {formatBytes(storage.estimatedBytes)}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    An <strong>estimate</strong>, not a measurement. Postgres reports size per
                    table, never per tenant, so each table&apos;s real on-disk size is
                    apportioned by this tenant&apos;s share of its rows. A tenant whose records
                    carry large text (long notes, attachments metadata) will use more than its
                    row share suggests; index and dead-tuple overhead is included.
                  </p>

                  {storage.breakdown.length > 0 && (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="py-2 font-semibold">Table</th>
                            <th className="py-2 text-right font-semibold">Rows</th>
                            <th className="py-2 text-right font-semibold">Share</th>
                            <th className="py-2 text-right font-semibold">Est. size</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {storage.breakdown.map((row) => (
                            <tr key={row.table}>
                              <td className="py-2 font-mono text-xs">{row.table}</td>
                              <td className="py-2 text-right tabular-nums">{row.rows}</td>
                              <td className="py-2 text-right tabular-nums text-muted-foreground">
                                {row.sharePct}%
                              </td>
                              <td className="py-2 text-right tabular-nums">{formatBytes(row.bytes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {storage.tablesOmitted > 0 && (
                    <p className="mt-2 text-[11px] text-muted-foreground/80">
                      {storage.tablesOmitted} smaller tenant-scoped table
                      {storage.tablesOmitted === 1 ? " was" : "s were"} not sampled — the tail
                      contributes little and would cost a query each.
                    </p>
                  )}
                </div>

                <div className="card p-5">
                  <h3 className="font-semibold">Activity, last 30 days</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <strong>Request traffic and bandwidth are not recorded anywhere in this
                    application</strong>, so they cannot be estimated from the database —
                    inventing a figure would be worse than saying so. These are business
                    activity counts, which is usually the underlying question.
                  </p>
                  <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    {[
                      { label: "Messages", value: activity.communications30d },
                      { label: "Leads created", value: activity.leadsCreated30d },
                      { label: "Contacts created", value: activity.contactsCreated30d },
                      { label: "Activities", value: activity.activities30d },
                      { label: "Audited changes", value: activity.auditEvents30d },
                      { label: "Sign-ins", value: activity.sessions30d },
                    ].map((row) => (
                      <div key={row.label} className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd className="tabular-nums">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            ),
          },
          {
            key: "errors",
            label: "Errors",
            count: errors.length,
            content:
              errors.length === 0 ? (
                <p className="card p-5 text-sm text-muted-foreground">
                  No errors attributed to this tenant in the last 7 days.
                </p>
              ) : (
                <ul className="card divide-y divide-border/50 p-0">
                  {errors.map((error) => (
                    <li key={error.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {error.scope}
                        </span>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {formatDateTime(error.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-sm text-foreground/90 [overflow-wrap:anywhere]">
                        {error.message}
                      </p>
                      {error.context && (
                        <p className="mt-0.5 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {error.context}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            key: "modules",
            label: "Modules",
            count: granted.size,
            content: (
              <form action={setTenantModulesAction.bind(null, tenant.id)} className="card p-5">
                <p className="text-sm text-muted-foreground">
                  What this tenant may use. Their own admin can switch a granted pack off,
                  but can never switch on one that is not granted. CRM core is always on.
                </p>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                  {OPTIONAL_MODULES.map((module) => (
                    <li key={module.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        id={`mod-${module.id}`}
                        name="modules"
                        value={module.id}
                        defaultChecked={granted.has(module.id)}
                        className="mt-0.5 shrink-0"
                      />
                      <label htmlFor={`mod-${module.id}`} className="min-w-0 flex-1 cursor-pointer">
                        <span className="block text-sm">{module.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {module.description}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <button className="btn-primary btn-sm mt-4">Save modules</button>
              </form>
            ),
          },
          {
            key: "members",
            label: "Members",
            count: members.length,
            content: (
              <div className="card p-5">
                <ul className="divide-y divide-border/50">
                  {members.map((member) => (
                    <li key={member.userId} className="flex items-center gap-2 py-2.5 text-sm">
                      <span className="min-w-0 flex-1">
                        {member.user.name}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {member.user.email}
                        </span>
                      </span>
                      {members.length > 1 ? (
                        <form action={removeTenantMemberAction.bind(null, tenant.id, member.userId)}>
                          <button className="text-xs text-red-400 transition-colors hover:text-red-300">
                            Remove
                          </button>
                        </form>
                      ) : (
                        <span
                          className="text-xs text-muted-foreground"
                          title="A tenant must keep at least one member"
                        >
                          Last member
                        </span>
                      )}
                    </li>
                  ))}
                </ul>

                <form action={addTenantMemberAction.bind(null, tenant.id)} className="mt-4 flex gap-2">
                  <select name="userId" className="input flex-1" required defaultValue="">
                    <option value="" disabled>
                      Add a member…
                    </option>
                    {addableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} — {user.email}
                      </option>
                    ))}
                  </select>
                  <button className="btn-secondary btn-sm" disabled={addableUsers.length === 0}>
                    Add
                  </button>
                </form>
                <p className="mt-2 text-[11px] text-muted-foreground/80">
                  Only users with no tenant are listed: sign-in requires exactly one tenant, so a
                  second membership would lock that user out entirely.
                </p>
              </div>
            ),
          },
        ]}
      />

      <ModalTrigger
        label="Danger zone"
        title={`Danger zone — ${tenant.name}`}
        buttonClass="btn-secondary btn-sm text-red-300"
      >
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {isFounding
              ? "This is the founding tenant. It cannot be suspended — every existing user and session depends on it, so suspending it would lock the whole business out."
              : "Suspending a tenant immediately makes its members unable to sign in. It is reversible."}
          </p>
          {!isFounding && tenant.active && (
            <form action={suspendTenantAction.bind(null, tenant.id)}>
              <button className="btn-primary w-full bg-red-600 hover:bg-red-500">
                Suspend this tenant
              </button>
            </form>
          )}
        </div>
      </ModalTrigger>
    </div>
  );
}
