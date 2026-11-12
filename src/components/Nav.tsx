"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, CircleHelp, SlidersHorizontal } from "lucide-react";
import { buildNav, type NavGroup, type NavLink } from "@/components/nav-config";
import { cn } from "@/lib/utils";
import { linkOnPhone } from "@/lib/phoneScope";
import { navLabelOverrides } from "@/lib/recordLabels";
import { useRecordLabels } from "@/components/RecordLabelsProvider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * THE SIDEBAR (redesign, 2026-11-12 — the "Denago CRM — sidebar redesign" canvas).
 * Pinned links and group headings carry an icon; the links inside a group are
 * text on a thin guide line. One group open at a time — the one holding the page
 * you are on opens when you arrive. Collapsed, it is a 72px rail of icons and
 * each group opens as a flyout. Rows are 44px for touch, 36px under a mouse.
 */

/** What each sidebar count means, for its label. */
const BADGE_MEANING: Record<string, string> = {
  "/inbox": "waiting for a reply",
  "/cases": "waiting",
  "/activities": "overdue",
};

const ROW = "min-h-11 pointer-fine:min-h-9 rounded-[10px]";
const HOVER = "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const RAIL_BUTTON = "relative grid size-11 shrink-0 place-items-center rounded-[10px] transition-colors";

const countText = (n: number) => (n > 99 ? "99+" : String(n));
const badgeLabel = (href: string, n: number) => `${n} ${BADGE_MEANING[href] ?? "waiting"}`;

function Count({ n, label, className }: { n: number; label: string; className?: string }) {
  return (
    <span
      aria-label={label}
      title={label}
      className={cn("inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold tabular-nums text-zinc-950", className)}
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
  rail = false,
  user,
}: {
  isAdmin?: boolean;
  permissions?: string[];
  enabledModules?: string[];
  badges?: Record<string, number>;
  /** The phone's menu (lib/phoneScope.ts): only the sections the phone keeps; a group left empty is dropped. */
  phone?: boolean;
  /** The collapsed 72px rail: icons, with each group as a flyout. */
  rail?: boolean;
  /** For the footer's account row. */
  user?: { name: string };
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
  // The phone has its own account controls in its top bar, and no Ask the CRM (lib/phoneScope.ts).
  const footerLinks = phone ? [] : built.footerLinks;
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

  if (rail) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center">
        <nav aria-label="Main" className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {topLinks.map((link) => {
            const n = badges[link.href] ?? 0;
            const label = n > 0 ? `${link.label}, ${badgeLabel(link.href, n)}` : link.label;
            return (
              <RailTip key={link.href} label={link.label}>
                <Link
                  href={link.href}
                  aria-label={label}
                  aria-current={isActive(link.href) ? "page" : undefined}
                  className={cn(RAIL_BUTTON, isActive(link.href) ? "bg-sidebar-accent text-primary" : cn("text-sidebar-foreground", HOVER))}
                >
                  <link.icon className="size-5" aria-hidden />
                  {n > 0 && <span aria-hidden className="absolute right-0 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold tabular-nums text-zinc-950">{countText(n)}</span>}
                </Link>
              </RailTip>
            );
          })}
          <div aria-hidden className="my-2 h-px w-8 shrink-0 bg-sidebar-border" />
          {groups.map((group) => (
            <RailGroup key={group.key} group={group} active={group.key === activeGroup} isActive={isActive} badges={badges} total={groupTotal(group)} />
          ))}
        </nav>
        {!phone && (
          <footer className="flex w-full flex-col items-center gap-1 border-t border-sidebar-border pt-3">
            {footerLinks.map((link) => (
              <RailTip key={link.href} label={link.label}>
                <Link href={link.href} aria-label={link.label} className={cn(RAIL_BUTTON, "border border-sidebar-border text-sidebar-foreground", HOVER)}>
                  <link.icon className="size-5 text-primary" aria-hidden />
                </Link>
              </RailTip>
            ))}
            <RailTip label="Settings">
              <Link href="/settings" aria-label="Settings" className={cn(RAIL_BUTTON, "text-sidebar-foreground", HOVER)}>
                <SlidersHorizontal className="size-5" aria-hidden />
              </Link>
            </RailTip>
            {user && (
              <RailTip label="Your account">
                <Link href="/settings?tab=account" aria-label="Your account" className={cn(RAIL_BUTTON, HOVER)}>
                  <Initials name={user.name} />
                </Link>
              </RailTip>
            )}
          </footer>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <nav aria-label="Main" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {topLinks.map((link) => {
          const active = isActive(link.href);
          const n = badges[link.href] ?? 0;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                ROW,
                "flex items-center gap-3 px-3 text-sm transition-colors",
                active ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : cn("font-medium text-sidebar-foreground", HOVER),
              )}
            >
              <link.icon className={cn("size-[18px] shrink-0", active ? "text-primary" : "text-sidebar-foreground")} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{link.label}</span>
              {n > 0 && <Count n={n} label={badgeLabel(link.href, n)} />}
            </Link>
          );
        })}

        {groups.length > 0 && <div aria-hidden className="mx-1 my-2.5 h-px shrink-0 bg-sidebar-border" />}

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
                className={cn(ROW, "flex w-full items-center gap-3 px-3 text-left text-sm font-medium text-sidebar-foreground transition-colors", HOVER)}
              >
                <group.icon className={cn("size-[18px] shrink-0", group.key === activeGroup && "text-primary")} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                {hidden > 0 && <Count n={hidden} label={`${hidden} in ${group.label}`} />}
                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")} aria-hidden />
              </button>
              {expanded && (
                <div id={panelId} className="ml-5 flex flex-col gap-0.5 border-l border-sidebar-border pl-[9px]">
                  {group.links.map((link) => (
                    <ChildLink key={link.href} link={link} active={isActive(link.href)} badge={badges[link.href]} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {(footerLinks.length > 0 || (!phone && user)) && (
        <footer className="flex flex-col gap-2 border-t border-sidebar-border pt-3">
          {footerLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? "page" : undefined}
              className={cn(ROW, "flex items-center gap-3 border border-sidebar-border px-3 text-sm font-medium text-sidebar-foreground transition-colors", HOVER)}
            >
              <link.icon className="size-[18px] shrink-0 text-primary" aria-hidden />
              <span>{link.label}</span>
            </Link>
          ))}
          {!phone && user && (
            <div className="flex items-center gap-1">
              <Link href="/settings?tab=account" className={cn(ROW, "flex min-w-0 flex-1 items-center gap-2.5 px-2 text-sm font-medium text-sidebar-foreground transition-colors", HOVER)}>
                <Initials name={user.name} />
                <span className="truncate">{user.name}</span>
              </Link>
              <Link href="/help" aria-label="Help" className={cn("grid size-11 shrink-0 place-items-center pointer-fine:size-9 rounded-[10px] text-sidebar-foreground transition-colors", HOVER)}>
                <CircleHelp className="size-[18px]" aria-hidden />
              </Link>
              <Link href="/settings" aria-label="Settings" className={cn("grid size-11 shrink-0 place-items-center pointer-fine:size-9 rounded-[10px] text-sidebar-foreground transition-colors", HOVER)}>
                <SlidersHorizontal className="size-[18px]" aria-hidden />
              </Link>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

function ChildLink({ link, active, badge = 0 }: { link: NavLink; active: boolean; badge?: number }) {
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        ROW,
        "flex items-center gap-2.5 px-3 text-sm transition-colors",
        active ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : cn("text-sidebar-foreground", HOVER),
      )}
    >
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      {badge > 0 && <Count n={badge} label={badgeLabel(link.href, badge)} />}
      {active && badge === 0 && <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />}
    </Link>
  );
}

function Initials({ name }: { name: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  return <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">{letters}</span>;
}

function RailTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A group on the rail: its icon, and its links in a flyout beside it — opened by
 * hovering or clicking, closed by Escape, by clicking away or by moving off it.
 * Radix's popover gives the keyboard path: Enter opens it and focus moves in.
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
          className={cn(RAIL_BUTTON, active || open ? "bg-sidebar-accent text-primary" : cn("text-sidebar-foreground", HOVER))}
        >
          <group.icon className="size-5" aria-hidden />
          {total > 0 && <span aria-hidden className="absolute right-0 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold tabular-nums text-zinc-950">{countText(total)}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={14}
        onMouseEnter={hold}
        onMouseLeave={hide}
        className="w-60 rounded-[14px] border-sidebar-border bg-card p-2 shadow-[0_16px_40px_rgba(0,0,0,.45)]"
      >
        <nav aria-label={group.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">{group.label}</p>
          {group.links.map((link) => (
            <Link key={link.href} href={link.href} onClick={() => setOpen(false)} aria-current={isActive(link.href) ? "page" : undefined}
              className={cn(ROW, "flex items-center gap-2.5 px-3 text-sm transition-colors", isActive(link.href) ? "bg-sidebar-accent font-semibold text-foreground" : cn("text-sidebar-foreground", HOVER))}
            >
              <span className="min-w-0 flex-1 truncate">{link.label}</span>
              {(badges[link.href] ?? 0) > 0 && <Count n={badges[link.href]} label={badgeLabel(link.href, badges[link.href])} />}
              {isActive(link.href) && !(badges[link.href] > 0) && <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />}
            </Link>
          ))}
        </nav>
      </PopoverContent>
    </Popover>
  );
}
