import Image from "next/image";
import Link from "next/link";
import PortalNav from "@/components/PortalNav";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="portal-shell relative min-h-screen overflow-hidden bg-[#090b0a] text-slate-100">
      <div className="portal-shell-ambient pointer-events-none fixed -right-48 -top-56 size-[600px] rounded-full bg-orange-600/[0.08] blur-[120px]" />
      <div className="portal-shell-ambient pointer-events-none fixed -bottom-72 -left-64 size-[560px] rounded-full bg-emerald-500/[0.035] blur-[130px]" />
      <header className="portal-header sticky top-0 z-30 border-b border-white/[0.07] bg-[#090b0a]/80 backdrop-blur-2xl">
        <div className="mx-auto flex h-[68px] max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/portal" aria-label="Customer portal home">
            <Image
              src="/branding/denago-cape-town-logo.png"
              alt="Denago Cape Town"
              width={230}
              height={58}
              className="h-7 w-auto object-contain sm:h-8"
            />
          </Link>
          <PortalNav mode="desktop" />
          <span className="ml-auto rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500 sm:ml-0">Customer portal</span>
        </div>
      </header>
      <PortalNav mode="mobile" />
      <main className="portal-main relative mx-auto max-w-6xl px-4 py-8 pb-28 sm:px-6 sm:py-12">{children}</main>
    </div>
  );
}
