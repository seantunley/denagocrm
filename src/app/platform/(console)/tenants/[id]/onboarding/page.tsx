import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Circle, ExternalLink, ShieldCheck } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { parseModuleCsv } from "@/lib/modules/entitlement";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { setTenantModulesAction } from "@/app/actions/tenants";
import { setTenantBrandAction, setTenantLogoAction } from "@/app/actions/tenantBranding";

export const dynamic = "force-dynamic";

const OPTIONAL_MODULES = MODULE_REGISTRY.filter((module) => !module.mandatory);

function Status({ done }: { done: boolean }) {
  return done ? <CheckCircle2 className="size-5 shrink-0 text-emerald-400" /> : <Circle className="size-5 shrink-0 text-muted-foreground" />;
}

function OwnerTask({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <li className="flex gap-3 rounded-lg border border-border/60 p-3">
      <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Link href={href} className="text-xs font-medium text-primary hover:underline">
        Open <ExternalLink className="ml-1 inline size-3" />
      </Link>
    </li>
  );
}

export default async function TenantOnboardingPage({ params }: { params: Promise<{ id: string }> }) {
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
      ownerUserId: true,
      brandDisplayName: true,
      brandTagline: true,
      brandPrimary: true,
      brandLogoRef: true,
      _count: { select: { members: true } },
      domains: { select: { verifiedAt: true } },
    },
  });
  if (!tenant) notFound();

  const granted = parseModuleCsv(tenant.modules);
  const identityDone = Boolean(tenant.brandDisplayName && tenant.brandPrimary && tenant.brandLogoRef);
  const domainDone = tenant.domains.some((domain) => domain.verifiedAt !== null);
  const modulesDone = granted.size > 0;
  const ownerDone = Boolean(tenant.ownerUserId && tenant._count.members > 0);
  const readiness = [identityDone, domainDone, modulesDone, ownerDone];
  const completed = readiness.filter(Boolean).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href={`/platform/tenants/${tenant.id}`} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Tenant profile
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">New tenant onboarding</p>
            <h1 className="mt-1 text-2xl font-semibold">Prepare {tenant.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">/{tenant.slug} · {completed} of {readiness.length} platform checks ready</p>
          </div>
          <span className={`badge ${tenant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
            {tenant.active ? "Active — owner handoff" : "Inert — safe to configure"}
          </span>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${(completed / readiness.length) * 100}%` }} />
        </div>
      </div>

      <section className="card space-y-4 p-5">
        <div className="flex gap-3"><Status done={identityDone} /><div><h2 className="font-semibold">1. Identity and brand</h2><p className="text-xs text-muted-foreground">Customer-facing name, tagline, accent and logo. These flow into the app shell and documents.</p></div></div>
        <SaveForm action={setTenantBrandAction.bind(null, tenant.id)} resetOnSuccess={false} closeModalOnSuccess={false} className="grid gap-3 sm:grid-cols-3">
          <div><label className="label">Display name</label><input className="input" name="brandDisplayName" required defaultValue={tenant.brandDisplayName ?? tenant.name} maxLength={120} /></div>
          <div><label className="label">Tagline</label><input className="input" name="brandTagline" defaultValue={tenant.brandTagline ?? ""} maxLength={160} /></div>
          <div><label className="label">Accent colour</label><input className="input" name="brandPrimary" required pattern="#[0-9a-fA-F]{6}" placeholder="#ea580c" defaultValue={tenant.brandPrimary ?? ""} /></div>
          <SaveButton className="btn-secondary sm:col-span-3 sm:justify-self-end">Save identity</SaveButton>
        </SaveForm>
        <SaveForm action={setTenantLogoAction.bind(null, tenant.id)} closeModalOnSuccess={false} className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1"><label className="label">Logo</label><input className="input" type="file" name="logo" required accept="image/png,image/jpeg,image/svg+xml,image/webp" /><p className="mt-1 text-[11px] text-muted-foreground">PNG, JPEG, SVG or WebP; maximum 1 MB.</p></div>
          <SaveButton className="btn-secondary">Upload logo</SaveButton>
        </SaveForm>
      </section>

      <section className="card space-y-4 p-5">
        <div className="flex gap-3"><Status done={modulesDone} /><div><h2 className="font-semibold">2. Module entitlement</h2><p className="text-xs text-muted-foreground">Grant only the product areas this tenant is contracted to use. Core CRM remains mandatory.</p></div></div>
        <SaveForm action={setTenantModulesAction.bind(null, tenant.id)} resetOnSuccess={false} closeModalOnSuccess={false} className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {OPTIONAL_MODULES.map((module) => <label key={module.id} className="flex gap-2 rounded-lg border border-border/60 p-3"><input type="checkbox" name="modules" value={module.id} defaultChecked={granted.has(module.id)} className="mt-0.5 size-4" /><span><span className="block text-sm font-medium">{module.label}</span><span className="block text-xs text-muted-foreground">{module.description}</span></span></label>)}
          </div>
          <SaveButton className="btn-secondary">Save entitlements</SaveButton>
        </SaveForm>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card p-5"><div className="flex gap-3"><Status done={domainDone} /><div><h2 className="font-semibold">3. Domain and login</h2><p className="mt-1 text-xs text-muted-foreground">Attach and verify the tenant hostname before expecting pre-login branding. Unverified domains never resolve a tenant.</p><Link href={`/platform/tenants/${tenant.id}`} className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">Manage domains and preview</Link></div></div></div>
        <div className="card p-5"><div className="flex gap-3"><Status done={ownerDone} /><div><h2 className="font-semibold">4. Owner and team</h2><p className="mt-1 text-xs text-muted-foreground">The provisioned owner must remain a member. Add each person to exactly one tenant and review roles after activation.</p><Link href={`/platform/tenants/${tenant.id}`} className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">Review members</Link></div></div></div>
      </section>

      <section className="card space-y-4 p-5">
        <div className="flex items-start gap-3"><ShieldCheck className="size-5 shrink-0 text-primary" /><div><h2 className="font-semibold">5. Activate, then hand off to the tenant owner</h2><p className="text-xs text-muted-foreground">Activation is deliberately separate. It is allowed only when tenant isolation enforcement is on. The owner then completes these tenant-scoped settings while signed into this workspace.</p></div></div>
        {!readiness.every(Boolean) && <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">Recommended before activation: complete identity, a verified domain, module grants and owner membership.</p>}
        <ul className="grid gap-2">
          <OwnerTask href="/settings/company" title="Company profile and document identity" description="Legal/trading name, address, contact details, social links, document logo and email signature." />
          <OwnerTask href="/settings/modules" title="Tenant module choices" description="Disable any granted packs the workspace does not want visible; entitlements cannot be exceeded." />
          <OwnerTask href="/settings/pipelines" title="Pipeline and sales process" description="Default pipeline, stages, stale thresholds, required fields and ownership workflow." />
          <OwnerTask href="/settings?tab=quotes" title="Quote and tax defaults" description="Validity period, deposit, terms, tax behavior, numbering and document templates." />
          <OwnerTask href="/settings?tab=email" title="Email and notifications" description="SMTP/IMAP, sender identity, templates, reminders and device notifications." />
          <OwnerTask href="/settings?tab=integrations" title="Integrations and social inbox" description="Connect only this tenant's WhatsApp, Meta, X and other providers; secrets stay encrypted and tenant-bound." />
          <OwnerTask href="/settings/access" title="Team, roles and security" description="Invite staff, assign least-privilege roles, require 2FA and verify record visibility." />
          <OwnerTask href="/settings?tab=import" title="Data import and launch check" description="Import tenant-owned contacts and records, test a lead-to-quote flow, then confirm inbox and Attention Centre behavior." />
        </ul>
      </section>

      <p className="text-xs text-muted-foreground">All readiness reads use the requested tenant ID explicitly. The wizard never borrows branding, domains, modules, members or completion state from another tenant.</p>
    </div>
  );
}
