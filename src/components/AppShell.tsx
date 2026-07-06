"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

export default function AppShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // close the drawer on navigation
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="min-h-screen">
      {/* Mobile top bar */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 bg-slate-900 border-b border-slate-800 px-4 h-14">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="text-slate-200 text-2xl leading-none cursor-pointer"
        >
          ☰
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/branding/denago-cape-town-logo.png"
          alt="Denago Cape Town"
          className="h-6 w-auto object-contain"
        />
      </header>

      {/* Drawer overlay (mobile) */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar: static on desktop, slide-in drawer on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 lg:w-56 bg-slate-900 border-r border-slate-800 flex flex-col transform transition-transform duration-200 lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {sidebar}
      </aside>

      <main className="lg:ml-56 p-4 pt-[4.5rem] lg:p-8 lg:pt-8">
        {children}
      </main>
    </div>
  );
}
