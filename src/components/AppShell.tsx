"use client";

import { useState } from "react";
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
} from "lucide-react";
import Nav from "@/components/Nav";
import SidebarHelpSettings from "@/components/SidebarHelpSettings";
import ClockWeather from "@/components/ClockWeather";
import CommandMenu, { openCommandMenu } from "@/components/CommandMenu";
import QuickActions from "@/components/QuickActions";
import QuickCreateDialog from "@/components/QuickCreateDialog";
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
  const modules = new Set(user.modules.split(",").map((item) => item.trim()).filter(Boolean));
  const has = (module: string) => user.role === "owner" || modules.has(module);
  const enabledSet = enabledModules ? new Set(enabledModules) : undefined;
  const packOn = (href: string) => !enabledSet || isPathEnabled(href, enabledSet);
  const items = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard, show: true },
    { href: "/leads", label: "Leads", icon: SquareKanban, show: has("crm") && packOn("/leads") },
    { href: "/inbox", label: "Inbox", icon: MessageSquare, show: has("inbox") && packOn("/inbox"), badge: inboxWaiting },
  ].filter((item) => item.show);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav
      data-mobile-navigation="true"
      className="fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-50 grid rounded-2xl border border-sidebar-border bg-sidebar/95 p-1.5 shadow-[0_22px_60px_rgba(0,0,0,.55)] backdrop-blur-xl lg:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
      aria-label="Primary navigation"
    >
      {items.map(({ href, label, icon: Icon, badge }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(href) ? "page" : undefined}
          className={cn(
            "relative flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors",
            active(href) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          )}
        >
          <Icon className="size-[18px]" />
          {label}
          {badge ? (
            <span className="absolute right-[22%] top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[8px] font-bold leading-4 text-primary-foreground">
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </Link>
      ))}
      <button
        type="button"
        onClick={onMore}
        className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <Menu className="size-[18px]" />
        More
      </button>
    </nav>
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
