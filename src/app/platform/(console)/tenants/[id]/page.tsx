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
  MessagesSquare,
  Camera,
  Star,
  Send,
  Sparkles,
  Mic,
} from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { formatDateTime } from "@/lib/format";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { parseModuleCsv } from "@/lib/modules/entitlement";
import { brandFromRow, brandLogoUrl } from "@/lib/tenantBrand";
import {
  setTenantBrandAction,
  setTenantLogoAction,
  clearTenantLogoAction,
  addTenantDomainAction,
  verifyTenantDomainAction,
  removeTenantDomainAction,
} from "@/app/actions/tenantBranding";
import {
  getTenantIntegrationHealth,
  integrationVerdict,
  type IntegrationId,
  type IntegrationStatus,
} from "@/lib/integrationHealth";
import Tabs from "@/components/Tabs";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import UsageTab from "@/components/platform/UsageTab";

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
  messenger: MessagesSquare,
  instagram: Camera,
  google_reviews: Star,
  telegram: Send,
  ai: Sparkles,
  voice: Mic,
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
    select: {
      id: true,
      name: true,
      slug: true,
      active: true,
      modules: true,
      createdAt: true,
      brandPrimary: true,
      brandLogoRef: true,
      brandDisplayName: true,
      brandTagline: true,
      domains: {
        select: { id: true, hostname: true, verifiedAt: true },
        orderBy: { hostname: "asc" },
      },
    },
  });
  if (!tenant) notFound();

  // What the login page will actually render for this tenant — resolved through
  // the same brandFromRow the page itself uses, so the preview cannot drift from
  // the real thing.
  const brand = brandFromRow({
    tenantId: tenant.id,
    brandPrimary: tenant.brandPrimary,
    brandLogoRef: tenant.brandLogoRef,
    brandDisplayName: tenant.brandDisplayName,
    brandTagline: tenant.brandTagline,
  });
  const brandLogo = brandLogoUrl(brand);

  const since24h = new Date(Date.now() - 24 * 3600_000);
  const since7d = new Date(Date.now() - 7 * 24 * 3600_000);

  const [members, addableUsers, lastSession, errors, integrations, errors24h, errors7d] =
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
      basePrisma.userSession.findFirst({
        where: { tenantId: id },
        orderBy: { lastActiveAt: "desc" },
        select: { lastActiveAt: true },
      }),
      // DISPLAY ONLY — capped. Counts must never be derived from this list: during
      // an error storm the cap truncates it and any total computed from it silently
      // under-reports.
      basePrisma.errorLog.findMany({
        where: { tenantId: id, createdAt: { gte: since7d } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, scope: true, message: true, context: true, createdAt: true },
      }),
      getTenantIntegrationHealth(id),
      // TOTALS — counted in the database, so they stay correct past the cap.
      basePrisma.errorLog.count({ where: { tenantId: id, createdAt: { gte: since24h } } }),
      basePrisma.errorLog.count({ where: { tenantId: id, createdAt: { gte: since7d } } }),
    ]);

  // Storage is NOT fetched here, and is not rendered on the server at all. It costs
  // one COUNT per sampled table — the most expensive thing the console does — and
  // used to run on every profile visit even for someone opening the Errors tab.
  // <UsageTab> now fetches it from the client when its tab is first opened.

  const granted = parseModuleCsv(tenant.modules);
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
              {/* Same signal as the list row, so a tenant that looked unhealthy there
                  still looks unhealthy once you open it. */}
              {errors24h > 0 && (
                <span className="badge inline-flex items-center gap-1 bg-red-500/15 text-red-300">
                  <AlertTriangle className="size-3" />
                  {errors24h} error{errors24h === 1 ? "" : "s"} 24h
                </span>
              )}
              {failingIntegrations > 0 && (
                <span className="badge inline-flex items-center gap-1 bg-red-500/15 text-red-300">
                  <AlertTriangle className="size-3" />
                  {failingIntegrations} integration{failingIntegrations === 1 ? "" : "s"} failing
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              /{tenant.slug} · created {formatDateTime(tenant.createdAt)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {tenant.active ? (
              !isFounding && (
                <SaveForm
                  action={suspendTenantAction.bind(null, tenant.id)}
                  success={`${tenant.name} suspended`}
                >
                  <SaveButton pendingLabel="Suspending…" className="btn-secondary btn-sm">
                    Suspend
                  </SaveButton>
                </SaveForm>
              )
            ) : (
              <SaveForm
                action={activateTenantAction.bind(null, tenant.id)}
                success={`${tenant.name} activated`}
              >
                <SaveButton
                  pendingLabel="Activating…"
                  className="btn-primary btn-sm"
                  disabled={!tenantEnforcing()}
                >
                  Activate
                </SaveButton>
              </SaveForm>
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
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          // Deliberately NOT lead or contact counts: those are sales metrics that say
          // nothing about whether a tenant is healthy or what it costs to run. What a
          // platform operator needs is who can get in, what they may use, how much
          // room they take, and whether anything is broken.
          { label: "Members", value: members.length },
          { label: "Modules", value: granted.size },
          // Storage deliberately is NOT here: showing it would drag the expensive
          // per-table scan back onto the critical path for every visit. It lives in
          // the Usage tab, which streams.
          { label: "Errors 7d", value: errors7d },
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
            // LAZY. The storage estimate costs one COUNT per sampled table — the most
            // expensive query in the console. Streaming it inside Suspense stopped it
            // blocking the page but still ran it on every profile visit, because the
            // tab strip mounts every panel. <UsageTab> is a client component that
            // fetches through an action, and `lazy` holds it back until this tab is
            // opened, so the scan happens only when somebody asks for it.
            lazy: true,
            content: <UsageTab tenantId={id} />,
          },
          {
            key: "errors",
            label: "Errors",
            // The real 7-day total, not the length of the capped display list.
            count: errors7d,
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
                  {/* Say so when the list is truncated, rather than letting the page
                      imply these are all of them. */}
                  {errors7d > errors.length && (
                    <li className="px-4 py-2 text-xs text-muted-foreground">
                      Showing the {errors.length} most recent of {errors7d}. Full detail is in
                      this tenant&apos;s Settings → System Log.
                    </li>
                  )}
                </ul>
              ),
          },
          {
            key: "modules",
            label: "Modules",
            count: granted.size,
            content: (
              <SaveForm
                action={setTenantModulesAction.bind(null, tenant.id)}
                success="Modules updated"
                // EDITS existing state rather than creating something, so the
                // checkboxes must keep showing what was just saved. A reset would
                // snap them back to the values this page was rendered with.
                resetOnSuccess={false}
                className="card p-5"
              >
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
                <SaveButton className="btn-primary btn-sm mt-4">Save modules</SaveButton>
              </SaveForm>
            ),
          },
          {
            key: "branding",
            label: "Branding",
            count: tenant.domains.length,
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-4">
                  <SaveForm
                    action={setTenantBrandAction.bind(null, tenant.id)}
                    success="Branding updated"
                    resetOnSuccess={false}
                    className="card p-5 space-y-3"
                  >
                    <div>
                      <h2 className="font-semibold">Brand</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        What this tenant&apos;s staff and customers see — login pages, app
                        chrome and documents. Leave a field blank to use the platform default.
                      </p>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">Display name</span>
                      <input
                        name="brandDisplayName"
                        className="input"
                        defaultValue={tenant.brandDisplayName ?? ""}
                        placeholder="Acme Golf Carts"
                        maxLength={120}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">Tagline</span>
                      <input
                        name="brandTagline"
                        className="input"
                        defaultValue={tenant.brandTagline ?? ""}
                        placeholder="Fleet sales & service"
                        maxLength={160}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">
                        Accent colour (six-digit hex; blank keeps the platform accent)
                      </span>
                      {/* One control, not two. A `type="color"` picker cannot express
                          "blank = no override" — it always holds some colour — so
                          pairing it with the text field would need JS to keep them in
                          step and would make "clear the accent" unreachable. The text
                          field is the value; the swatch beside it just shows what is
                          currently saved. */}
                      <span className="flex items-center gap-2">
                        <input
                          name="brandPrimary"
                          className="input flex-1"
                          defaultValue={tenant.brandPrimary ?? ""}
                          placeholder="#ea580c"
                          pattern="#[0-9a-fA-F]{6}"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <span
                          aria-hidden
                          title={brand.primary ?? "No accent set"}
                          className="size-9 shrink-0 rounded border border-border"
                          style={{ backgroundColor: brand.primary ?? "transparent" }}
                        />
                      </span>
                    </label>
                    <SaveButton className="btn-primary btn-sm">Save branding</SaveButton>
                  </SaveForm>

                  <div className="card p-5 space-y-3">
                    <div>
                      <h2 className="font-semibold">Logo</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        PNG, JPEG, SVG or WebP, up to 1&nbsp;MB. Replacing deletes the old
                        file after the new one is saved.
                      </p>
                    </div>
                    {/* Plain <img>, not next/image: the logo is streamed from our own
                        route at an intrinsic size nothing records, and next/image needs
                        dimensions up front. Optimisation is not the point for a
                        ≤1 MB brand mark rendered once on an admin screen. */}
                    {brandLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={brandLogo}
                        alt={`${brand.displayName} logo`}
                        className="max-h-16 w-auto rounded bg-white/5 p-2"
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No logo set — surfaces use the platform default.
                      </p>
                    )}
                    <SaveForm
                      action={setTenantLogoAction.bind(null, tenant.id)}
                      success="Logo updated"
                      resetOnSuccess={false}
                      className="flex items-center gap-2"
                    >
                      <input
                        type="file"
                        name="logo"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp"
                        className="input flex-1"
                      />
                      <SaveButton className="btn-secondary btn-sm">Upload</SaveButton>
                    </SaveForm>
                    {tenant.brandLogoRef && (
                      <SaveForm
                        action={clearTenantLogoAction.bind(null, tenant.id)}
                        success="Logo removed"
                        resetOnSuccess={false}
                      >
                        <SaveButton className="btn-ghost btn-sm text-muted-foreground">
                          Remove logo
                        </SaveButton>
                      </SaveForm>
                    )}
                  </div>

                  <div className="card p-5 space-y-3">
                    <div>
                      <h2 className="font-semibold">Domains</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Hostnames that serve this tenant&apos;s white-labelled app. Branding
                        only applies on <em>verified</em> hostnames — verify one after
                        confirming the tenant controls its DNS.
                      </p>
                    </div>
                    <ul className="divide-y divide-border/50">
                      {tenant.domains.length === 0 && (
                        <li className="py-2 text-xs text-muted-foreground">
                          No hostnames registered. The tenant is reachable only on the
                          platform default domain, unbranded.
                        </li>
                      )}
                      {tenant.domains.map((domain) => (
                        <li key={domain.id} className="flex items-center gap-2 py-2 text-sm">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {domain.hostname}
                          </span>
                          {domain.verifiedAt ? (
                            <span className="badge bg-emerald-500/15 text-emerald-300">
                              Verified
                            </span>
                          ) : (
                            <>
                              <span className="badge bg-amber-500/15 text-amber-300">
                                Pending
                              </span>
                              <SaveForm
                                action={verifyTenantDomainAction.bind(null, tenant.id, domain.id)}
                                success={`${domain.hostname} verified`}
                                resetOnSuccess={false}
                              >
                                <SaveButton className="btn-secondary btn-sm">Verify</SaveButton>
                              </SaveForm>
                            </>
                          )}
                          <SaveForm
                            action={removeTenantDomainAction.bind(null, tenant.id, domain.id)}
                            success={`${domain.hostname} removed`}
                            resetOnSuccess={false}
                          >
                            <SaveButton className="btn-ghost btn-sm text-muted-foreground">
                              Remove
                            </SaveButton>
                          </SaveForm>
                        </li>
                      ))}
                    </ul>
                    <SaveForm
                      action={addTenantDomainAction.bind(null, tenant.id)}
                      success="Hostname added"
                      className="flex items-center gap-2"
                    >
                      <input
                        name="hostname"
                        className="input flex-1"
                        placeholder="crm.acme.co.za"
                        autoComplete="off"
                      />
                      <SaveButton className="btn-secondary btn-sm">Add</SaveButton>
                    </SaveForm>
                  </div>
                </div>

                {/* Live preview — rendered from the SAME brandFromRow + brandStyle the
                    login page uses, so what the admin sees is what ships. A platform
                    admin setting a brand for someone else cannot check by signing in
                    as them; this panel is that check. */}
                <div className="card p-5">
                  <h2 className="font-semibold">Login preview</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    How this tenant&apos;s sign-in page greets staff on a verified hostname.
                  </p>
                  <div
                    className="mt-4 rounded-xl border border-border bg-[#020617] p-6"
                    style={
                      brand.primary
                        ? ({ "--primary": brand.primary, "--primary-foreground": brand.primaryForeground } as React.CSSProperties)
                        : undefined
                    }
                  >
                    {brandLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={brandLogo} alt="" className="mb-4 max-h-10 w-auto" />
                    ) : null}
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
                      Staff portal
                    </p>
                    <p className="mt-2 text-xl font-semibold tracking-tight text-white">
                      Welcome back.
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Sign in to {brand.displayName}.
                    </p>
                    <span className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground">
                      Sign in
                    </span>
                    {brand.tagline && (
                      <p className="mt-4 text-[10px] text-slate-500">{brand.tagline}</p>
                    )}
                  </div>
                </div>
              </div>
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
                        <SaveForm
                          action={removeTenantMemberAction.bind(null, tenant.id, member.userId)}
                          success={`${member.user.name} removed`}
                        >
                          <SaveButton
                            pendingLabel="Removing…"
                            className="text-xs text-red-400 transition-colors hover:text-red-300"
                          >
                            Remove
                          </SaveButton>
                        </SaveForm>
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

                <SaveForm
                  action={addTenantMemberAction.bind(null, tenant.id)}
                  success="Member added"
                  className="mt-4 flex gap-2"
                >
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
                  <SaveButton
                    pendingLabel="Adding…"
                    className="btn-secondary btn-sm"
                    disabled={addableUsers.length === 0}
                  >
                    Add
                  </SaveButton>
                </SaveForm>
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
            <SaveForm
              action={suspendTenantAction.bind(null, tenant.id)}
              success={`${tenant.name} suspended`}
            >
              <SaveButton
                pendingLabel="Suspending…"
                className="btn-primary w-full bg-red-600 hover:bg-red-500"
              >
                Suspend this tenant
              </SaveButton>
            </SaveForm>
          )}
        </div>
      </ModalTrigger>
    </div>
  );
}
