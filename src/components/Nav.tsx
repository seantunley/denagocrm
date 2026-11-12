"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "framer-motion";
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
/** Where you are: bold, on the raised pill (Pill) that glides between links. */
const RAISED = "font-semibold text-sidebar-accent-foreground";

/*
 * QUIET MOTION (sidebar brief PR 3). Only transform and opacity move. Under
 * prefers-reduced-motion, MotionConfig reducedMotion="user" turns off every
 * transform and layout animation — same layout, nothing moves — and the CSS
 * transitions carry motion-reduce:transition-none.
 */
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * The raised pill behind the current link. One per sidebar (the LayoutGroup's
 * `id` scopes it), so it glides to a newly active link (~180ms) instead of
 * jumping — and the phone drawer's pill never animates across to the desktop's.
 */
function Pill() {
  return (
    <motion.span
      layoutId="nav-pill"
      aria-hidden
      transition={{ duration: 0.18, ease: EASE_OUT }}
      className="depth-raised absolute inset-0 -z-10 rounded-[10px]"
    />
  );
}

const countText = (n: number) => (n > 99 ? "99+" : String(n));
const badgeLabel = (href: string, n: number) => `${n} ${BADGE_MEANING[href] ?? "waiting"}`;

/**
 * A count: the accent with a light top edge and a drop shadow; dark digits for
 * contrast. When the number goes UP it pulses once (to ~1.15 and back, 300ms) —
 * never on first render, never looping: the pulse is keyed on how many times it
 * has risen, so each rise remounts and plays the animation exactly once.
 */
export function Count({ n, label, className }: { n: number; label: string; className?: string }) {
  const [seen, setSeen] = useState({ n, rises: 0 });
  // Derived during render (React's "store information from previous renders"), not in an effect.
  if (seen.n !== n) setSeen({ n, rises: n > seen.n ? seen.rises + 1 : seen.rises });
  return (
    <motion.span
      key={seen.rises}
      aria-label={label}
      title={label}
      animate={seen.rises > 0 ? { scale: [1, 1.15, 1] } : undefined}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-primary depth-sheen px-1.5 text-xs font-bold tabular-nums text-[#1a0d05]", className)}
    >
      {countText(n)}
    </motion.span>
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

  // A faint shadow under the search block once the menu has scrolled.
  const [scrolled, setScrolled] = useState(false);

  return (
    <MotionConfig reducedMotion="user">
    <LayoutGroup id={phone ? "nav-drawer" : "nav-desktop"}>
    <nav aria-label="Main" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)} className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2">
      <div aria-hidden className={cn("pointer-events-none sticky top-0 z-20 -mx-1 -mb-3 h-3 shrink-0 bg-gradient-to-b from-black/45 to-transparent transition-opacity duration-150 motion-reduce:transition-none", scrolled ? "opacity-100" : "opacity-0")} />
      {topLinks.map((link) => {
        const active = isActive(link.href);
        const n = badges[link.href] ?? 0;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(ROW, "relative isolate flex items-center gap-3 px-3 text-sm transition-colors", active ? RAISED : cn("font-medium text-sidebar-foreground", HOVER))}
          >
            {active && <Pill />}
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
              <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-90")} aria-hidden />
            </button>
            {expanded && (
              // Opening: the links ease in from just behind the heading — 150ms,
              // a few pixels and a fade. Hovering a link brightens the guide line.
              <motion.div
                id={panelId}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15, ease: EASE_OUT }}
                className="ml-5 flex flex-col gap-0.5 border-l border-white/[0.12] pl-[9px] has-[a:hover]:border-white/30"
              >
                {group.links.map((link) => (
                  <ChildLink key={link.href} link={link} active={isActive(link.href)} badge={badges[link.href]} />
                ))}
              </motion.div>
            )}
          </div>
        );
      })}
    </nav>
    </LayoutGroup>
    </MotionConfig>
  );
}

function ChildLink({ link, active, badge = 0 }: { link: NavLink; active: boolean; badge?: number }) {
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={cn(ROW, "relative isolate flex items-center gap-2.5 px-3 text-sm transition-colors", active ? RAISED : cn("text-sidebar-foreground", HOVER))}
    >
      {active && <Pill />}
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      {badge > 0 && <Count n={badge} label={badgeLabel(link.href, badge)} />}
    </Link>
  );
}
