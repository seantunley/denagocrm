import Image from "next/image";
import Link from "next/link";

const PORTAL_NAV = [
  { href: "/portal", label: "Overview" },
  { href: "/portal/support", label: "Support & warranty" },
  { href: "/portal/documents", label: "Documents" },
  { href: "/portal/profile", label: "Profile" },
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#090b0a] text-slate-100">
      <div className="pointer-events-none fixed -right-48 -top-56 size-[600px] rounded-full bg-orange-600/[0.08] blur-[120px]" />
      <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-black/20 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <Link href="/portal" aria-label="Customer portal home">
            <Image
              src="/branding/denago-cape-town-logo.png"
              alt="Denago Cape Town"
              width={230}
              height={58}
              className="h-7 w-auto object-contain"
            />
          </Link>
          <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Customer portal</span>
        </div>
        <nav className="max-w-4xl mx-auto px-4 pb-3 flex gap-2 overflow-x-auto text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {PORTAL_NAV.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.035] px-3.5 py-1.5 text-[13px] font-medium text-slate-300 transition-colors hover:border-orange-400/30 hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="relative max-w-4xl mx-auto px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
