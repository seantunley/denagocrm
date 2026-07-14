"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Headphones, House, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/portal", label: "Overview", icon: House },
  { href: "/portal/support", label: "Support", icon: Headphones },
  { href: "/portal/documents", label: "Documents", icon: FileText },
  { href: "/portal/profile", label: "Profile", icon: UserRound },
];

function isActive(pathname: string, href: string) {
  return href === "/portal" ? pathname === href : pathname.startsWith(href);
}

export default function PortalNav({ mode = "all" }: { mode?: "all" | "desktop" | "mobile" }) {
  const pathname = usePathname();

  return (
    <>
      {mode !== "mobile" && <nav className="ml-auto hidden items-center gap-1 sm:flex" aria-label="Customer portal">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors",
                active ? "bg-white/[0.075] text-white shadow-sm" : "text-slate-400 hover:bg-white/[0.04] hover:text-white"
              )}
            >
              <Icon className={cn("size-4", active ? "text-orange-400" : "text-slate-500")} />
              {label}
            </Link>
          );
        })}
      </nav>}

      {mode !== "desktop" && <nav className="portal-mobile-nav fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-40 grid grid-cols-4 rounded-2xl border border-white/10 bg-[#111412]/95 p-1.5 shadow-[0_22px_60px_rgba(0,0,0,.55)] backdrop-blur-xl sm:hidden" aria-label="Customer portal">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors",
                active ? "bg-orange-500/12 text-orange-300" : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"
              )}
            >
              <Icon className="size-[18px]" />
              {label}
            </Link>
          );
        })}
      </nav>}
    </>
  );
}
