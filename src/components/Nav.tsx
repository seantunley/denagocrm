"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavLink = { href: string; label: string; icon: string };
type NavGroup = { key: string; label: string; links: NavLink[] };

const topLinks: NavLink[] = [
  { href: "/", label: "Dashboard", icon: "▦" },
  { href: "/reports", label: "Reports", icon: "📊" },
];

const groups: NavGroup[] = [
  {
    key: "crm",
    label: "CRM",
    links: [
      { href: "/leads", label: "Leads", icon: "◎" },
      { href: "/inbox", label: "Social Inbox", icon: "💬" },
      { href: "/quotes", label: "Quotes", icon: "📄" },
      { href: "/contacts", label: "Contacts", icon: "☰" },
      { href: "/activities", label: "Activities", icon: "✓" },
      { href: "/calendar", label: "Calendar", icon: "📅" },
      { href: "/automations", label: "Automations", icon: "🤖" },
      { href: "/products", label: "Products", icon: "⬡" },
      { href: "/library", label: "Library", icon: "📁" },
    ],
  },
  {
    key: "workshop",
    label: "Workshop",
    links: [
      { href: "/vehicles", label: "Vehicles", icon: "⚡" },
      { href: "/jobcards", label: "Job Cards", icon: "🔧" },
      { href: "/workshop-calendar", label: "Workshop Cal", icon: "📅" },
    ],
  },
];


const STORAGE_KEY = "denago-nav-collapsed";

function NavItem({ link, active }: { link: NavLink; active: boolean }) {
  return (
    <Link
      href={link.href}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-orange-600 text-white"
          : "text-slate-300 hover:bg-slate-800 hover:text-white"
      }`}
    >
      <span className="w-4 text-center">{link.icon}</span>
      {link.label}
    </Link>
  );
}

export default function Nav() {
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
    <nav className="space-y-1">
      {topLinks.map((l) => (
        <NavItem key={l.href} link={l} active={isActive(l.href)} />
      ))}

      {groups.map((group) => {
        const groupActive = group.links.some((l) => isActive(l.href));
        // never hide the group that holds the current page
        const isCollapsed = collapsed[group.key] && !groupActive;
        return (
          <div key={group.key} className="pt-2">
            <button
              onClick={() => toggle(group.key)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              {group.label}
              <span
                className={`text-[10px] transition-transform ${
                  isCollapsed ? "-rotate-90" : ""
                }`}
              >
                ▼
              </span>
            </button>
            {!isCollapsed && (
              <div className="space-y-0.5">
                {group.links.map((l) => (
                  <NavItem key={l.href} link={l} active={isActive(l.href)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

    </nav>
  );
}
