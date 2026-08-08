import Link from "next/link";
import { notFound } from "next/navigation";
import PortalNav from "@/components/PortalNav";
import { Toaster } from "@/components/ui/sonner";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { getPortalContact } from "@/lib/portal";
import { customerBrand, BrandStyle } from "@/lib/loginBrand";
import BrandLogo from "@/components/BrandLogo";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // The customer portal is itself an optional module; when switched off in
  // Settings → Modules the whole portal (including login) is unavailable.
  if (!(await isModuleEnabled("portal"))) notFound();
  // Contact-first, hostname as the fallback: this layout wraps BOTH the
  // authenticated portal and its own login page, and only one of those has a
  // customer to ask. Never throws — see customerBrand.
  const contact = await getPortalContact().catch(() => null);
  const brand = await customerBrand(contact?.tenantId ?? null);
  return (
    <>
      <BrandStyle brand={brand} />
    <div className="portal-shell relative min-h-screen overflow-hidden bg-[#090b0a] text-slate-100">
      <div className="portal-shell-ambient pointer-events-none fixed -right-48 -top-56 size-[600px] rounded-full bg-orange-600/[0.08] blur-[120px]" />
      <div className="portal-shell-ambient pointer-events-none fixed -bottom-72 -left-64 size-[560px] rounded-full bg-emerald-500/[0.035] blur-[130px]" />
      <header className="portal-header sticky top-0 z-30 border-b border-white/[0.07] bg-[#090b0a]/80 backdrop-blur-2xl">
        <div className="mx-auto flex h-[68px] max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/portal" aria-label="Customer portal home">
            <BrandLogo
              logoUrl={brand.logoUrl}
              alt={brand.displayName}
              className="h-7 w-auto object-contain sm:h-8"
            />
          </Link>
          <PortalNav mode="desktop" />
          <span className="ml-auto rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500 sm:ml-0">Customer portal</span>
        </div>
      </header>
      <PortalNav mode="mobile" />
      <main className="portal-main relative mx-auto max-w-6xl px-4 py-8 pb-28 sm:px-6 sm:py-12">{children}</main>
      {/* Customers get the same save feedback staff do; the portal is outside
          AppShell, so it needs its own Toaster. */}
      <Toaster />
    </div>
    </>
  );
}
