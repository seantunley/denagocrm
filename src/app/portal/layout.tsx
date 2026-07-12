import Link from "next/link";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/95 sticky top-0 z-20 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <Link href="/portal" aria-label="Customer portal home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/branding/denago-cape-town-logo.png"
              alt="Denago Cape Town"
              className="h-7 w-auto object-contain"
            />
          </Link>
          <span className="text-xs text-slate-500">Customer portal</span>
        </div>
        <nav className="max-w-5xl mx-auto px-4 pb-3 flex gap-2 overflow-x-auto text-sm">
          <Link className="btn-secondary btn-sm whitespace-nowrap" href="/portal">Overview</Link>
          <Link className="btn-secondary btn-sm whitespace-nowrap" href="/portal/support">Support & warranty</Link>
          <Link className="btn-secondary btn-sm whitespace-nowrap" href="/portal/documents">Documents</Link>
          <Link className="btn-secondary btn-sm whitespace-nowrap" href="/portal/profile">Profile</Link>
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
