"use client";

import { useState, type ReactNode } from "react";
import BrandLogo from "@/components/BrandLogo";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Search,
  Settings,
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
import MobileCompanionNav from "@/components/MobileCompanionNav";
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

type ShellUser = { name: string; role: string; permissions: string[]; avatarVersion?: string | null };

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function SidebarInner({ user, inboxWaiting = 0, casesWaiting = 0, enabledModules, brand }: { user: ShellUser; inboxWaiting?: number; casesWaiting?: number; enabledModules?: string[]; brand?: { logoUrl: string | null; displayName: string } }) {
  const isOwner = user.role === "owner";
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-sidebar">
      <div className="pointer-events-none absolute -left-28 top-24 size-64 rounded-full bg-orange-500/[0.055] blur-3xl" />
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-4">
        <BrandLogo
          logoUrl={brand?.logoUrl ?? null}
          alt={brand?.displayName ?? "Denago Cape Town"}
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
        <QuickActions isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} />
      </div>

      {/* Nav */}
      <div className="relative flex-1 overflow-y-auto px-3 py-3">
        <Nav isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} badges={{ "/inbox": inboxWaiting, "/cases": casesWaiting }} />
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

export default function AppShell({
  user,
  inboxWaiting = 0,
  casesWaiting = 0,
  enabledModules,
  brand,
  children,
}: {
  user: ShellUser;
  inboxWaiting?: number;
  casesWaiting?: number;
  enabledModules?: string[];
  /** The workspace brand, resolved from the SESSION's tenant by the (app)
   *  layout. Optional so every existing test render still compiles; undefined
   *  means the built-in assets, which is what an unbranded tenant gets. */
  brand?: { logoUrl: string | null; displayName: string };
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  return (
    <TooltipProvider delayDuration={250}>
    <div className="min-h-screen">
      <CommandMenu isAdmin={user.role === "owner"} permissions={user.permissions} enabledModules={enabledModules} />
      <QuickCreateDialog />
      <Toaster />

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-12 items-center justify-center border-b border-sidebar-border bg-sidebar/90 px-4 backdrop-blur-xl lg:hidden">
        <BrandLogo
          logoUrl={brand?.logoUrl ?? null}
          alt={brand?.displayName ?? "Denago Cape Town"}
          className="h-6 w-auto object-contain"
        />
      </header>

      {/* Mobile drawer */}
      <Sheet key={pathname} open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarInner user={user} inboxWaiting={inboxWaiting} casesWaiting={casesWaiting} enabledModules={enabledModules} brand={brand} />
        </SheetContent>
      </Sheet>

      <MobileCompanionNav
        user={user}
        pathname={pathname}
        inboxWaiting={inboxWaiting}
        casesWaiting={casesWaiting}
        enabledModules={enabledModules}
        onMore={() => setMobileOpen(true)}
      />

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-sidebar-border lg:flex lg:flex-col">
        <SidebarInner user={user} inboxWaiting={inboxWaiting} casesWaiting={casesWaiting} enabledModules={enabledModules} brand={brand} />
      </aside>

      <main className="relative lg:pl-60">
        <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(circle_at_65%_0%,rgba(249,115,22,.045),transparent_42%)] lg:left-60" />
        <div className="denago-workspace mx-auto max-w-[1800px] p-3 pb-24 pt-15 sm:p-4 sm:pb-24 sm:pt-16 lg:p-5 lg:pt-4">
          {/* Desktop-only furniture — takes real estate on phones */}
          <div className="mb-3 hidden lg:block">
            <ClockWeather />
          </div>
          {children}
        </div>
      </main>
    </div>
    </TooltipProvider>
  );
}
