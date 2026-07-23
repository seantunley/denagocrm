"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Menu,
  MessageSquare,
  Search,
  Settings,
  SquareKanban,
  Trash2,
  LogOut,
  ChevronsUpDown,
  CalendarPlus,
  FileText,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import Nav from "@/components/Nav";
import SidebarHelpSettings from "@/components/SidebarHelpSettings";
import ClockWeather from "@/components/ClockWeather";
import CommandMenu, { openCommandMenu } from "@/components/CommandMenu";
import QuickActions from "@/components/QuickActions";
import QuickCreateDialog, {
  openQuickCreate,
  type QuickCreateKind,
} from "@/components/QuickCreateDialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { logout } from "@/app/login/actions";
import { APP_VERSION } from "@/lib/version";
import { cn } from "@/lib/utils";
import { isPathEnabled } from "@/lib/modules/registry";

type ShellUser = { name: string; role: string; modules: string; permissions: string[]; avatarVersion?: string | null };

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function SidebarInner({ user, inboxWaiting = 0, casesWaiting = 0, enabledModules }: { user: ShellUser; inboxWaiting?: number; casesWaiting?: number; enabledModules?: string[] }) {
  const isOwner = user.role === "owner";
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-sidebar">
      <div className="pointer-events-none absolute -left-28 top-24 size-64 rounded-full bg-orange-500/[0.055] blur-3xl" />
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-4">
        <Image
          src="/branding/denago-cape-town-logo.png"
          alt="Denago Cape Town"
          width={230}
          height={58}
          className="h-8 w-auto object-contain"
        />
      </div>

      {/* Command trigger + quick actions */}
      <div className="relative space-y-2 px-3 pt-3">
        <button
          onClick={openCommandMenu}
          className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded border border-sidebar-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </button>
        <QuickActions modules={user.modules} isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} />
      </div>

      {/* Nav */}
      <div className="relative flex-1 overflow-y-auto px-3 py-3">
        <Nav modules={user.modules} isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} badges={{ "/inbox": inboxWaiting, "/cases": casesWaiting }} />
      </div>

      {/* Help, Settings & user */}
      <div className="space-y-1 border-t border-sidebar-border p-3">
        <SidebarHelpSettings isOwner={isOwner} permissions={user.permissions} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent">
              <Avatar className="size-7 rounded-md">
                {user.avatarVersion ? (
                  <AvatarImage
                    src={`/api/profile/avatar?v=${encodeURIComponent(user.avatarVersion)}`}
                    alt=""
                    className="rounded-md object-cover"
                  />
                ) : null}
                <AvatarFallback className="rounded-md bg-primary/15 text-[11px] font-semibold text-primary">
                  {initials(user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-sidebar-foreground">
                  {user.name}
                </p>
                <p className="truncate text-[11px] capitalize text-muted-foreground">
                  {user.role}
                </p>
              </div>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[13.5rem]">
            <DropdownMenuLabel className="text-muted-foreground">
              v{APP_VERSION}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            {isOwner && (
              <DropdownMenuItem asChild>
                <Link href="/trash">
                  <Trash2 className="size-4" />
                  Trash
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => logout()}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function MobilePrimaryNav({
  user,
  pathname,
  inboxWaiting,
  enabledModules,
  onMore,
}: {
  user: ShellUser;
  pathname: string;
  inboxWaiting: number;
  enabledModules?: string[];
  onMore: () => void;
}) {
  type MobileQuickAction = {
    kind: QuickCreateKind;
    label: string;
    icon: LucideIcon;
  };

  const modules = new Set(user.modules.split(",").map((item) => item.trim()).filter(Boolean));
  const has = (module: string) => user.role === "owner" || modules.has(module);
  const granted = new Set(user.permissions);
  const can = (...keys: string[]) => user.role === "owner" || keys.some((key) => granted.has(key));
  const enabledSet = enabledModules ? new Set(enabledModules) : undefined;
  const packOn = (href: string) => !enabledSet || isPathEnabled(href, enabledSet);
  const createActions: MobileQuickAction[] = [
    ...(can("leads.create") && packOn("/leads")
      ? [{ kind: "lead" as const, label: "New lead", icon: SquareKanban }]
      : []),
    ...(can("contacts.create") && packOn("/contacts")
      ? [{ kind: "contact" as const, label: "New contact", icon: UserPlus }]
      : []),
    ...(can("activities.manage") && packOn("/calendar")
      ? [{ kind: "calendar" as const, label: "Schedule activity", icon: CalendarPlus }]
      : []),
    ...(can("quotes.create") && packOn("/quotes")
      ? [{ kind: "quote" as const, label: "New quote", icon: FileText }]
      : []),
  ];
  const items = [
    {
      href: "/",
      label: "Dashboard",
      icon: LayoutDashboard,
      show: true,
      actions: createActions.filter((action) => action.kind !== "quote"),
    },
    {
      href: "/leads",
      label: "Leads",
      icon: SquareKanban,
      show: has("crm") && packOn("/leads"),
      actions: createActions.filter((action) => ["lead", "contact", "quote"].includes(action.kind)),
    },
    {
      href: "/inbox",
      label: "Inbox",
      icon: MessageSquare,
      show: has("inbox") && packOn("/inbox"),
      badge: inboxWaiting,
      actions: createActions.filter((action) => ["contact", "calendar"].includes(action.kind)),
    },
  ].filter((item) => item.show);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);
  const [quickMenu, setQuickMenu] = useState<{ label: string; actions: MobileQuickAction[] } | null>(null);

  function showQuickMenu(label: string, actions: MobileQuickAction[]) {
    if (!actions.length) return;
    setQuickMenu({ label, actions });
    if ("vibrate" in navigator) navigator.vibrate(12);
  }

  return (
    <>
      {quickMenu && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/25 lg:hidden"
            aria-label="Close quick actions"
            onClick={() => setQuickMenu(null)}
          />
          <section
            className="fixed inset-x-3 bottom-[calc(max(.75rem,env(safe-area-inset-bottom))+4.75rem)] z-50 rounded-2xl border border-sidebar-border bg-sidebar/98 p-2 shadow-[0_24px_70px_rgba(0,0,0,.65)] backdrop-blur-xl lg:hidden"
            aria-label={`${quickMenu.label} quick actions`}
          >
            <div className="flex items-center justify-between px-2 pb-2 pt-1">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Quick actions</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{quickMenu.label}</p>
              </div>
              <span className="rounded-full border border-border px-2 py-1 text-[9px] text-muted-foreground">
                Hold any marked icon
              </span>
            </div>
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${quickMenu.actions.length}, minmax(0, 1fr))` }}>
              {quickMenu.actions.map(({ kind, label, icon: Icon }) => (
                <button
                  key={kind}
                  type="button"
                  className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border border-transparent px-2 text-center text-[10px] font-medium text-foreground transition-colors hover:border-border hover:bg-sidebar-accent active:scale-[0.98]"
                  onClick={() => {
                    setQuickMenu(null);
                    openQuickCreate(kind);
                  }}
                >
                  <span className="grid size-8 place-items-center rounded-xl bg-primary/12 text-primary">
                    <Icon className="size-4" />
                  </span>
                  {label}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      <nav
        data-mobile-navigation="true"
        className="fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-50 grid rounded-2xl border border-sidebar-border bg-sidebar/95 p-1.5 shadow-[0_22px_60px_rgba(0,0,0,.55)] backdrop-blur-xl lg:hidden"
        style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
        aria-label="Primary navigation"
      >
        {items.map(({ href, label, icon: Icon, badge, actions }) => (
          <MobileNavPressTarget
            key={href}
            href={href}
            label={label}
            active={active(href)}
            badge={badge}
            hasQuickActions={actions.length > 0}
            onClick={() => setQuickMenu(null)}
            onLongPress={() => showQuickMenu(label, actions)}
          >
            <Icon className="size-[18px]" />
          </MobileNavPressTarget>
        ))}
        <MobileNavPressTarget
          label="More"
          hasQuickActions={createActions.length > 0}
          onClick={() => {
            setQuickMenu(null);
            onMore();
          }}
          onLongPress={() => showQuickMenu("Create", createActions)}
        >
          <Menu className="size-[18px]" />
        </MobileNavPressTarget>
      </nav>
    </>
  );
}

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE = 10;

function MobileNavPressTarget({
  href,
  label,
  active = false,
  badge,
  hasQuickActions,
  onClick,
  onLongPress,
  children,
}: {
  href?: string;
  label: string;
  active?: boolean;
  badge?: number;
  hasQuickActions: boolean;
  onClick?: () => void;
  onLongPress: () => void;
  children: ReactNode;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const longPressedRef = useRef(false);

  function cancelTimer() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function startPress(event: ReactPointerEvent<HTMLElement>) {
    if (!hasQuickActions || event.button !== 0) return;
    cancelTimer();
    longPressedRef.current = false;
    originRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      onLongPress();
      timerRef.current = null;
    }, LONG_PRESS_MS);
  }

  function movePress(event: ReactPointerEvent<HTMLElement>) {
    if (
      Math.abs(event.clientX - originRef.current.x) > LONG_PRESS_MOVE_TOLERANCE ||
      Math.abs(event.clientY - originRef.current.y) > LONG_PRESS_MOVE_TOLERANCE
    ) {
      cancelTimer();
    }
  }

  function handleClick(event: React.MouseEvent<HTMLElement>) {
    if (longPressedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      longPressedRef.current = false;
      return;
    }
    onClick?.();
  }

  const className = cn(
    "relative flex min-h-12 touch-manipulation select-none flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors",
    active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
  );
  const sharedProps = {
    className,
    title: hasQuickActions ? `${label} — hold for quick actions` : label,
    onPointerDown: startPress,
    onPointerMove: movePress,
    onPointerUp: cancelTimer,
    onPointerCancel: cancelTimer,
    onPointerLeave: cancelTimer,
    onClick: handleClick,
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      if (!hasQuickActions) return;
      event.preventDefault();
      if (longPressedRef.current) return;
      onLongPress();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (hasQuickActions && event.shiftKey && event.key === "F10") {
        event.preventDefault();
        onLongPress();
      }
    },
  };
  const content = (
    <>
      {children}
      {label}
      {hasQuickActions && (
        <span className="absolute right-[28%] top-1 size-1 rounded-full bg-primary/80" aria-hidden="true" />
      )}
      {badge ? (
        <span className="absolute right-[22%] top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[8px] font-bold leading-4 text-primary-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </>
  );

  return href ? (
    <Link href={href} aria-current={active ? "page" : undefined} {...sharedProps}>
      {content}
    </Link>
  ) : (
    <button type="button" {...sharedProps}>
      {content}
    </button>
  );
}

export default function AppShell({
  user,
  inboxWaiting = 0,
  casesWaiting = 0,
  enabledModules,
  children,
}: {
  user: ShellUser;
  inboxWaiting?: number;
  casesWaiting?: number;
  enabledModules?: string[];
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  return (
    <TooltipProvider delayDuration={250}>
    <div className="min-h-screen">
      <CommandMenu modules={user.modules} isAdmin={user.role === "owner"} permissions={user.permissions} enabledModules={enabledModules} />
      <QuickCreateDialog />
      <Toaster />

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-sidebar-border bg-sidebar/90 px-4 backdrop-blur-xl lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="-ml-2 flex size-10 items-center justify-center rounded-lg text-sidebar-foreground transition hover:bg-sidebar-accent"
        >
          <Menu className="size-5" />
        </button>
        <Image
          src="/branding/denago-cape-town-logo.png"
          alt="Denago Cape Town"
          width={230}
          height={58}
          className="h-6 w-auto object-contain"
        />
        <button
          onClick={openCommandMenu}
          aria-label="Search"
          className="-mr-2 ml-auto flex size-10 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground"
        >
          <Search className="size-5" />
        </button>
      </header>

      {/* Mobile drawer */}
      <Sheet key={pathname} open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarInner user={user} inboxWaiting={inboxWaiting} casesWaiting={casesWaiting} enabledModules={enabledModules} />
        </SheetContent>
      </Sheet>

      <MobilePrimaryNav
        user={user}
        pathname={pathname}
        inboxWaiting={inboxWaiting}
        enabledModules={enabledModules}
        onMore={() => setMobileOpen(true)}
      />

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-sidebar-border lg:flex lg:flex-col">
        <SidebarInner user={user} inboxWaiting={inboxWaiting} casesWaiting={casesWaiting} enabledModules={enabledModules} />
      </aside>

      <main className="relative lg:pl-60">
        <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(circle_at_65%_0%,rgba(249,115,22,.045),transparent_42%)] lg:left-60" />
        <div className="denago-workspace mx-auto max-w-[1800px] p-4 pb-24 pt-[4.5rem] lg:p-7 lg:pt-6">
          {/* Desktop-only furniture — takes real estate on phones */}
          <div className="mb-5 hidden lg:block">
            <ClockWeather />
          </div>
          {children}
        </div>
      </main>
    </div>
    </TooltipProvider>
  );
}
