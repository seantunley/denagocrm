"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "framer-motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  rail = false,
}: {
  isAdmin?: boolean;
  permissions?: string[];
  enabledModules?: string[];
  badges?: Record<string, number>;
  /** The phone's menu (lib/phoneScope.ts): only the sections the phone keeps; a group left empty is dropped. */
  phone?: boolean;
  /** The collapsed 72px rail (brief PR 4): pinned icons, one icon per group, each group a flyout. */
  rail?: boolean;
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

  if (rail) {
    return (
      <MotionConfig reducedMotion="user">
      <nav aria-label="Main" className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-2">
        {topLinks.map((link) => {
          const active = isActive(link.href);
          const n = badges[link.href] ?? 0;
          return (
            <RailTip key={link.href} label={link.label}>
              <Link
                href={link.href}
                aria-label={n > 0 ? `${link.label}, ${badgeLabel(link.href, n)}` : link.label}
                aria-current={active ? "page" : undefined}
                className={cn(RAIL_BUTTON, active ? "depth-raised text-primary" : cn("text-sidebar-foreground", HOVER))}
              >
                <link.icon className="size-5" aria-hidden />
                {n > 0 && <RailCount n={n} />}
              </Link>
            </RailTip>
          );
        })}
        {groups.length > 0 && <div aria-hidden className="depth-groove my-2 w-8 shrink-0" />}
        {groups.map((group) => (
          <RailGroup key={group.key} group={group} active={group.key === activeGroup} isActive={isActive} badges={badges} total={groupTotal(group)} />
        ))}
      </nav>
      </MotionConfig>
    );
  }

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

/* ── The collapsed rail (sidebar brief PR 4) ─────────────────────────────── */

const RAIL_BUTTON = "relative grid size-11 shrink-0 place-items-center rounded-[10px] transition-colors";

/** A count on a rail icon — the same pulse as Count, smaller and pinned to the corner. */
function RailCount({ n }: { n: number }) {
  return <Count n={n} label="" className="absolute -right-0.5 top-0 h-[18px] min-w-[18px] px-1 text-[11px]" />;
}

/** A pinned icon's name, after the app's usual short delay (TooltipProvider in AppShell). */
function RailTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A group on the rail: its icon, and its links in a flyout beside it — the top
 * depth level (depth-float), scaling up slightly from the icon. Opens on hover
 * and on click; closes on Escape, on clicking away, or on leaving it. Radix's
 * popover is the keyboard path: Enter opens it, focus moves in, and closing
 * returns focus to the icon.
 */
function RailGroup({
  group,
  active,
  isActive,
  badges,
  total,
}: {
  group: NavGroup;
  active: boolean;
  isActive: (href: string) => boolean;
  badges: Record<string, number>;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };
  const show = () => {
    hold();
    setOpen(true);
  };
  const hide = () => {
    hold();
    closing.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => hold, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={total > 0 ? `${group.label}, ${total} waiting` : group.label}
          onMouseEnter={show}
          onMouseLeave={hide}
          className={cn(RAIL_BUTTON, active || open ? "depth-raised text-primary" : cn("text-sidebar-foreground", HOVER))}
        >
          <group.icon className="size-5" aria-hidden />
          {total > 0 && <RailCount n={total} />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={14}
        onMouseEnter={hold}
        onMouseLeave={hide}
        className="depth-float w-60 rounded-[14px] border-0 bg-[var(--depth-float)] p-2 motion-reduce:animate-none"
      >
        <nav aria-label={group.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">{group.label}</p>
          {group.links.map((link) => {
            const here = isActive(link.href);
            const n = badges[link.href] ?? 0;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                aria-current={here ? "page" : undefined}
                className={cn(ROW, "flex items-center gap-2.5 px-3 text-sm transition-colors", here ? "depth-raised font-semibold text-foreground" : cn("text-sidebar-foreground", HOVER))}
              >
                <span className="min-w-0 flex-1 truncate">{link.label}</span>
                {n > 0 && <Count n={n} label={badgeLabel(link.href, n)} />}
                {here && n === 0 && <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_rgb(0_0_0/0.25)]" />}
              </Link>
            );
          })}
        </nav>
      </PopoverContent>
    </Popover>
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
