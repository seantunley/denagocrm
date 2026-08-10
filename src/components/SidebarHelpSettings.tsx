"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BellRing,
  BookOpen,
  Building2,
  ChevronRight,
  Database,
  ExternalLink,
  FileText,
  Info,
  Keyboard,
  LifeBuoy,
  Rocket,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openCommandMenu } from "@/components/CommandMenu";
import { APP_VERSION } from "@/lib/version";
import { SETTINGS_NAV_GROUPS, settingsHref } from "@/lib/settings-navigation";

const ROW =
  "group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-all hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground";

const ICON_TRIGGER =
  "group grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-primary";

const PANEL =
  "overflow-hidden rounded-2xl border-sidebar-border/80 bg-popover/98 p-0 shadow-[0_24px_80px_rgba(0,0,0,.38)] backdrop-blur-xl";

const GROUP_ICONS: Record<string, LucideIcon> = {
  Workspace: Settings2,
  Personal: UserRound,
  Organisation: Building2,
  "Sales & CRM": SlidersHorizontal,
  Operations: Wrench,
  Communications: BellRing,
  "Documents & Data": Database,
  "Security & Access": ShieldCheck,
  System: Activity,
};

/**
 * Icon-only triggers for the top bar, full rows for the sidebar.
 *
 * The panels themselves are identical — only the trigger and the side the panel
 * opens from change, because a bar at the top of the page cannot open a menu
 * upwards or to the right the way a sidebar footer could.
 */
export default function SidebarHelpSettings({
  isOwner,
  permissions = [],
  compact = false,
}: {
  isOwner: boolean;
  permissions?: string[];
  /** Render as icon buttons in a horizontal row, for the top bar. */
  compact?: boolean;
}) {
  const pathname = usePathname();
  const held = new Set(permissions);
  const canSee = (item: (typeof SETTINGS_NAV_GROUPS)[number]["items"][number]) => {
    if (isOwner || item.everyone) return true;
    if (!item.permission) return false;
    const need = Array.isArray(item.permission) ? item.permission : [item.permission];
    return need.some((permission) => held.has(permission));
  };
  const settingsGroups = SETTINGS_NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(canSee) }))
    .filter((group) => group.items.length > 0);

  const triggerClass = compact ? ICON_TRIGGER : ROW;
  const panelSide = compact ? "bottom" : "right";
  const panelAlign = "end" as const;

  return (
    <div className={compact ? "flex items-center gap-1" : "space-y-0.5"}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={triggerClass} aria-label={compact ? "Help" : undefined}>
            <span className={compact ? "contents" : "grid size-7 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent/50 text-muted-foreground transition-colors group-hover:text-primary group-data-[state=open]:text-primary"}>
              <LifeBuoy className="size-3.5" />
            </span>
            {!compact && <span className="flex-1 text-left">Help</span>}
            {!compact && <ChevronRight className="size-3.5 text-muted-foreground/50 transition-transform group-data-[state=open]:translate-x-0.5 group-data-[state=open]:text-primary" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={panelSide}
          align={panelAlign}
          sideOffset={10}
          collisionPadding={16}
          className={`w-[min(22rem,calc(100vw-2rem))] ${PANEL}`}
        >
          <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-primary/15 via-primary/[0.04] to-transparent px-4 py-4">
            <div className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full bg-primary/15 blur-2xl" />
            <div className="relative flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <LifeBuoy className="size-[18px]" />
              </span>
              <div>
                <p className="font-semibold tracking-tight text-foreground">Help centre</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Guides, shortcuts and reference material when you need it.</p>
              </div>
            </div>
          </div>

          <div className="p-2">
            <DropdownMenuItem asChild className="group h-auto rounded-xl border border-primary/15 bg-primary/[0.06] p-3 focus:bg-primary/10">
              <Link href="/help/finding-your-way-around" className="items-start">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary"><Rocket className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">Start here</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">A quick tour of the CRM and its everyday workflows.</span>
                </span>
                <ChevronRight className="mt-1 size-4 transition-transform group-focus:translate-x-0.5" />
              </Link>
            </DropdownMenuItem>

            <div className="mt-2 grid gap-1">
              <DropdownMenuItem asChild className="group h-auto rounded-lg p-2.5">
                <Link href="/help" className="items-start">
                  <BookOpen className="mt-0.5 size-4 text-primary" />
                  <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-foreground">Browse the user manual</span><span className="block text-[11px] text-muted-foreground">Searchable, task-focused help</span></span>
                  <ChevronRight className="mt-1 size-3.5 opacity-40 transition group-focus:translate-x-0.5 group-focus:opacity-100" />
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="group h-auto rounded-lg p-2.5">
                <Link href="/manual" target="_blank" className="items-start">
                  <FileText className="mt-0.5 size-4 text-primary" />
                  <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-foreground">Open the full manual</span><span className="block text-[11px] text-muted-foreground">Printable reference in a new tab</span></span>
                  <ExternalLink className="mt-1 size-3.5 opacity-40 transition group-focus:opacity-100" />
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem className="group h-auto rounded-lg p-2.5" onSelect={(event) => { event.preventDefault(); openCommandMenu(); }}>
                <Keyboard className="mt-0.5 size-4 text-primary" />
                <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-foreground">Search &amp; shortcuts</span><span className="block text-[11px] text-muted-foreground">Jump anywhere without leaving the keyboard</span></span>
                <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">⌘K</kbd>
              </DropdownMenuItem>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/70 bg-muted/20 px-3 py-2">
            <DropdownMenuItem asChild className="rounded-lg px-2 py-1.5 text-xs">
              <Link href="/help/welcome"><Info className="size-3.5" /> About Denago CRM</Link>
            </DropdownMenuItem>
            <span className="pr-2 text-[10px] font-medium text-muted-foreground/70">v{APP_VERSION}</span>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={triggerClass} aria-label={compact ? "Settings" : undefined}>
            <span className={compact ? "contents" : "grid size-7 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent/50 text-muted-foreground transition-colors group-hover:text-primary group-data-[state=open]:text-primary"}>
              <Settings className="size-3.5" />
            </span>
            {!compact && <span className="flex-1 text-left">Settings</span>}
            {!compact && <ChevronRight className="size-3.5 text-muted-foreground/50 transition-transform group-data-[state=open]:translate-x-0.5 group-data-[state=open]:text-primary" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={panelSide}
          align={panelAlign}
          sideOffset={10}
          collisionPadding={16}
          className={`flex max-h-[min(80vh,48rem)] w-[min(38rem,calc(100vw-2rem))] flex-col ${PANEL}`}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-popover/95 px-4 py-3.5 backdrop-blur-xl">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Settings className="size-[18px]" /></span>
            <div className="min-w-0 flex-1"><p className="font-semibold tracking-tight text-foreground">Workspace settings</p><p className="mt-0.5 text-xs text-muted-foreground">Manage your profile, organisation and connected tools.</p></div>
            <DropdownMenuItem asChild className="h-8 shrink-0 rounded-lg border border-border bg-muted/30 px-2.5 text-xs font-medium">
              <Link href="/settings">View all <ChevronRight className="size-3.5" /></Link>
            </DropdownMenuItem>
          </div>

          <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable] sm:grid-cols-2">
            {settingsGroups.map((group) => {
              const Icon = GROUP_ICONS[group.label] ?? Settings2;
              return (
                <section key={group.label} className="rounded-xl border border-border/70 bg-muted/[0.14] p-1.5">
                  <DropdownMenuLabel className="flex items-center gap-2 px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    <span className="grid size-6 place-items-center rounded-md bg-background/80 text-primary shadow-sm"><Icon className="size-3.5" /></span>
                    {group.label}
                  </DropdownMenuLabel>
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const href = settingsHref(item);
                      const active = href === "/settings"
                        ? pathname === "/settings"
                        : !href.includes("?") && (pathname === href || pathname.startsWith(`${href}/`));
                      return (
                        <DropdownMenuItem key={item.key} asChild className={`group rounded-lg px-2.5 py-2 text-[13px] ${active ? "bg-primary/10 text-primary focus:bg-primary/15 focus:text-primary" : "text-foreground/85"}`}>
                          <Link href={href} aria-current={active ? "page" : undefined}>
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            <ChevronRight className={`size-3.5 transition-all group-focus:translate-x-0.5 ${active ? "text-primary" : "opacity-25 group-focus:opacity-70"}`} />
                          </Link>
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
