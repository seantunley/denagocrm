"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { buildNav, type NavLink } from "@/components/nav-config";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "denago-nav-collapsed";

function NavItem({ link, active, badge }: { link: NavLink; active: boolean; badge?: number }) {
  const Icon = link.icon;
  return (
    <Link
      href={link.href}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon
        className={cn(
          "size-[17px] shrink-0 transition-colors",
          active
            ? "text-primary"
            : "text-muted-foreground group-hover:text-sidebar-accent-foreground"
        )}
        strokeWidth={2}
      />
      <span className="truncate">{link.label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span
          className="ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 py-px text-[10px] font-bold tabular-nums text-primary-foreground"
          title={`${badge} waiting for a reply`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

export default function Nav({
  modules = "crm,workshop,reports,inbox",
  isAdmin = false,
  badges = {},
}: {
  modules?: string;
  isAdmin?: boolean;
  /** href → count, e.g. { "/inbox": 2 } renders a pill on that item */
  badges?: Record<string, number>;
}) {
  const { topLinks, groups } = buildNav(modules, isAdmin);
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setCollapsed(JSON.parse(stored));
    } catch {}
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  return (
    <nav className="space-y-0.5">
      {topLinks.map((l) => (
        <NavItem key={l.href} link={l} active={isActive(l.href)} badge={badges[l.href]} />
      ))}

      {groups.map((group) => {
        const groupActive = group.links.some((l) => isActive(l.href));
        const isCollapsed = collapsed[group.key] && !groupActive;
        return (
          <div key={group.key} className="pt-3">
            <button
              onClick={() => toggle(group.key)}
              className="group flex w-full items-center gap-1 px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform duration-200",
                  isCollapsed ? "" : "rotate-90"
                )}
              />
              {group.label}
            </button>
            {!isCollapsed && (
              <div className="space-y-0.5">
                {group.links.map((l) => (
                  <NavItem key={l.href} link={l} active={isActive(l.href)} badge={badges[l.href]} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
