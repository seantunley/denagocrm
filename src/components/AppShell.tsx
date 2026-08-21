"use client";

import { useState, type ReactNode } from "react";
import BrandLogo from "@/components/BrandLogo";
import { usePathname } from "next/navigation";
import {
  Search,
} from "lucide-react";
import Nav from "@/components/Nav";
import SidebarHelpSettings from "@/components/SidebarHelpSettings";
import AccountMenu from "@/components/AccountMenu";
import ClockWeather from "@/components/ClockWeather";
import type { WeatherCity } from "@/lib/weatherCities";
import CommandMenu, { openCommandMenu } from "@/components/CommandMenu";
import QuickActions from "@/components/QuickActions";
import QuickCreateDialog from "@/components/QuickCreateDialog";
import MobileCompanionNav from "@/components/MobileCompanionNav";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ConnectivityIndicator from "@/components/ConnectivityIndicator";

type ShellUser = { id: string; name: string; role: string; permissions: string[]; avatarVersion?: string | null };

/**
 * Help, Settings and the account menu, as one horizontal group.
 *
 * These used to sit in the sidebar footer. They are workspace-level controls
 * rather than navigation, and moving them to the top-right returns the footer's
 * height to the nav — which is what runs out of room as modules are added.
 */
function AccountCluster({ user, isOwner }: { user: ShellUser; isOwner: boolean }) {
  return (
    // Held together as one object rather than three loose icons: a hairline
    // border and a barely-there fill, so it reads as a group without competing
    // with the page. The divider separates "app help" from "you".
    <div className="flex items-center gap-0.5 rounded-xl border border-sidebar-border/70 bg-sidebar-accent/25 p-1 transition-colors hover:border-sidebar-border">
      <SidebarHelpSettings isOwner={isOwner} permissions={user.permissions} compact />
      <div className="mx-0.5 h-5 w-px bg-sidebar-border/70" aria-hidden />
      <AccountMenu user={user} isOwner={isOwner} compact />
    </div>
  );
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

    </div>
  );
}

export default function AppShell({
  user,
  inboxWaiting = 0,
  casesWaiting = 0,
  enabledModules,
  brand,
  weatherCities,
  tenantId,
  children,
}: {
  user: ShellUser;
  inboxWaiting?: number;
  casesWaiting?: number;
  enabledModules?: string[];
  /** The tenant's clock/weather cities, resolved by the (app) layout. */
  weatherCities: WeatherCity[];
  tenantId: string;
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

      {/* Mobile top bar. Three columns, not a centred logo with the cluster
          floating over it: an absolutely-positioned cluster reserves NO layout
          space, so on a 375px screen a wordmark brand — BrandLogo falls back to
          the workspace name, whitespace-nowrap, up to 120 characters — ran
          straight underneath the controls. The outer columns are the same width,
          so the logo is still optically centred, and it CLIPS rather than
          growing into the cluster. */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-12 items-center gap-2 border-b border-sidebar-border bg-sidebar/90 px-2 backdrop-blur-xl lg:hidden">
        <div className="w-[7.5rem] shrink-0">
          <ConnectivityIndicator tenantId={tenantId} userId={user.id} />
        </div>
        {/* min-w-0 lets the flex item shrink below its content, overflow-hidden
            clips what is left. Together the centre column can never grow past its
            own width, so the logo cannot reach the cluster whatever it contains. */}
        <div className="flex min-w-0 flex-1 justify-center overflow-hidden">
          <BrandLogo
            logoUrl={brand?.logoUrl ?? null}
            alt={brand?.displayName ?? "Denago Cape Town"}
            className="h-6 w-auto max-w-full object-contain"
          />
        </div>
        <div className="flex w-[7.5rem] shrink-0 justify-end">
          <AccountCluster user={user} isOwner={user.role === "owner"} />
        </div>
      </header>

      {/* Desktop top bar. Sticky rather than static: these are the controls you
          reach for from anywhere in a long page, and the sidebar footer they came
          from was always on screen. */}
      <header className="fixed left-60 right-0 top-0 z-30 hidden h-14 items-center gap-4 border-b border-sidebar-border bg-background/80 px-5 backdrop-blur-xl lg:flex">
        <div className="min-w-0 flex-1">
          <ClockWeather cities={weatherCities} />
        </div>
        <ConnectivityIndicator tenantId={tenantId} userId={user.id} />
        <AccountCluster user={user} isOwner={user.role === "owner"} />
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
        <div className="denago-workspace mx-auto max-w-[1800px] p-3 pb-24 pt-15 sm:p-4 sm:pb-24 sm:pt-16 lg:p-5 lg:pt-19">
          {/* ClockWeather moved into the top bar — it was already desktop-only
              furniture at the top of the page, so the bar is where it belongs
              and the page keeps the vertical space the bar takes. */}
          {children}
        </div>
      </main>
    </div>
    </TooltipProvider>
  );
}
