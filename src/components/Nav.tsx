"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { buildNav, type NavGroup, type NavLink } from "@/components/nav-config";
import { cn } from "@/lib/utils";
import { linkOnPhone } from "@/lib/phoneScope";
import { navLabelOverrides } from "@/lib/recordLabels";
import { useRecordLabels } from "@/components/RecordLabelsProvider";

/*
 * THE SIDEBAR MENU (sidebar-implementation-brief.md PR 2; the canvas board
 * "Sidebar — with subtle depth"). Pinned links and group headings carry an icon;
 * links inside a group are text on a thin guide line. One group open at a time,
 * and the one holding the page you are on opens when you arrive. Where you are is
 * a raised pill (globals.css depth-*); everything else stays flat. Rows are 36px
 * under a mouse, 44px on touch.
 */

/** What each sidebar count means, for its label. */
const BADGE_MEANING: Record<string, string> = {
  "/inbox": "waiting for a reply",
  "/cases": "waiting",
  "/activities": "overdue",
};

const ROW = "min-h-11 pointer-fine:min-h-9 rounded-[10px]";
const HOVER = "hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground";
/** Where you are: raised off the sidebar. */
const RAISED = "depth-raised font-semibold text-sidebar-accent-foreground";

const countText = (n: number) => (n > 99 ? "99+" : String(n));
const badgeLabel = (href: string, n: number) => `${n} ${BADGE_MEANING[href] ?? "waiting"}`;

/** A count: the accent with a light top edge and a drop shadow; dark digits for contrast. */
export function Count({ n, label, className }: { n: number; label: string; className?: string }) {
  return (
    <span
      aria-label={label}
      title={label}
      className={cn("inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-primary depth-sheen px-1.5 text-xs font-bold tabular-nums text-[#1a0d05]", className)}
    >
      {countText(n)}
    </span>
  );
}

export default function Nav({
  isAdmin = false,
  permissions = [],
  enabledModules,
  badges = {},
  phone = false,
}: {
  isAdmin?: boolean;
  permissions?: string[];
  enabledModules?: string[];
  badges?: Record<string, number>;
  /** The phone's menu (lib/phoneScope.ts): only the sections the phone keeps; a group left empty is dropped. */
  phone?: boolean;
}) {
  const built = buildNav(
    isAdmin,
    permissions,
    enabledModules ? new Set(enabledModules) : undefined,
    navLabelOverrides(useRecordLabels()),
  );
  const topLinks = phone ? built.topLinks.filter((link) => linkOnPhone(link.href)) : built.topLinks;
  const groups = phone
    ? built.groups.map((group) => ({ ...group, links: group.links.filter((link) => linkOnPhone(link.href)) })).filter((group) => group.links.length > 0)
    : built.groups;
  const pathname = usePathname();

  // The most specific match wins: /jobcards/insights is Insights, not Job Cards.
  const allHrefs = [...topLinks, ...groups.flatMap((group) => group.links)].map((link) => link.href);
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const current = allHrefs.filter(matches).sort((a, b) => b.length - a.length)[0] ?? null;
  const isActive = (href: string) => href === current;
  const activeGroup = groups.find((group) => group.links.some((link) => isActive(link.href)))?.key ?? null;

  // ONE group open at a time. Arriving on a page opens its group; opening
  // another closes the one before. A choice is made on a page and lasts while
  // you stay on it — derived, so no effect has to reset it on navigation.
  const [choice, setChoice] = useState<{ page: string; open: string | null } | null>(null);
  const open = choice?.page === pathname ? choice.open : activeGroup;
  const setOpen = (key: string | null) => setChoice({ page: pathname, open: key });

  const groupTotal = (group: NavGroup) => group.links.reduce((sum, link) => sum + (badges[link.href] ?? 0), 0);

  return (
    <nav aria-label="Main" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2">
      {topLinks.map((link) => {
        const active = isActive(link.href);
        const n = badges[link.href] ?? 0;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(ROW, "flex items-center gap-3 px-3 text-sm transition-colors", active ? RAISED : cn("font-medium text-sidebar-foreground", HOVER))}
          >
            <link.icon className={cn("size-[18px] shrink-0", active && "text-primary")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{link.label}</span>
            {n > 0 && <Count n={n} label={badgeLabel(link.href, n)} />}
          </Link>
        );
      })}

      {groups.length > 0 && <div aria-hidden className="depth-groove mx-1 my-2.5 shrink-0" />}

      {groups.map((group) => {
        const expanded = open === group.key;
        // A closed group must not hide its counts: the heading carries their total.
        const hidden = expanded ? 0 : groupTotal(group);
        const panelId = `nav-group-${group.key}`;
        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => setOpen(expanded ? null : group.key)}
              className={cn(
                ROW,
                "flex w-full items-center gap-3 px-3 text-left text-sm transition-colors",
                expanded ? "font-semibold text-sidebar-accent-foreground" : "font-medium text-sidebar-foreground",
                HOVER,
              )}
            >
              <group.icon className="size-[18px] shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              {hidden > 0 && <Count n={hidden} label={`${hidden} in ${group.label}`} />}
              <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")} aria-hidden />
            </button>
            {expanded && (
              <div id={panelId} className="ml-5 flex flex-col gap-0.5 border-l border-white/[0.12] pl-[9px]">
                {group.links.map((link) => (
                  <ChildLink key={link.href} link={link} active={isActive(link.href)} badge={badges[link.href]} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function ChildLink({ link, active, badge = 0 }: { link: NavLink; active: boolean; badge?: number }) {
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={cn(ROW, "flex items-center gap-2.5 px-3 text-sm transition-colors", active ? RAISED : cn("text-sidebar-foreground", HOVER))}
    >
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      {badge > 0 && <Count n={badge} label={badgeLabel(link.href, badge)} />}
    </Link>
  );
}
