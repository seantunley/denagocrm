"use client";

import { useEffect, useState, type ReactNode } from "react";
import BrandLogo from "@/components/BrandLogo";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Bell,
  Cake,
  PanelLeftClose,
  PanelLeftOpen,
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
import PhoneGate from "@/components/PhoneGate";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ConnectivityIndicator from "@/components/ConnectivityIndicator";
import { ActivityTypesProvider } from "@/components/ActivityTypesProvider";
import { MoneyFormatProvider } from "@/components/MoneyFormatProvider";
import { DEFAULT_REGIONAL, type MoneyFormat } from "@/lib/format";
import { RecordLabelsProvider } from "@/components/RecordLabelsProvider";
import type { RecordLabels } from "@/lib/recordLabels";
import { SettingsViewerProvider } from "@/components/SettingsViewer";
import type { ActivityType } from "@/lib/activityTypes";

type ShellUser = {
  id: string;
  name: string;
  role: string;
  permissions: string[];
  avatarVersion?: string | null;
  /**
   * Owner of the WORKSPACE being viewed (requireTenantOwner) — what the nav and
   * menus treat as "owner". `role === "owner"` is the PLATFORM-wide owner, which a
   * workspace's own owner never has, so gating on it hid the owner's own
   * surfaces (Chatbot, Flow builder, Trash, …) from every workspace but the first.
   * Optional so existing test renders compile; absent means the platform answer.
   */
  isTenantOwner?: boolean;
};

const ownsWorkspace = (user: ShellUser) => user.isTenantOwner ?? user.role === "owner";

/**
 * Help, Settings and the account menu, as one horizontal group.
 *
 * These used to sit in the sidebar footer. They are workspace-level controls
 * rather than navigation, and moving them to the top-right returns the footer's
 * height to the nav — which is what runs out of room as modules are added.
 */
function AccountCluster({ user, isOwner, tenantId, unreadNotices = 0, birthdaysToday = 0 }: { user: ShellUser; isOwner: boolean; tenantId: string; unreadNotices?: number; birthdaysToday?: number }) {
  return (
    // Held together as one object rather than three loose icons: a hairline
    // border and a barely-there fill, so it reads as a group without competing
    // with the page. The divider separates "app help" from "you".
    // Solid `sidebar-accent` rather than a fraction of it: the bar behind this is
    // oklch(0.171) and the accent is oklch(0.246), so every alpha below 100% was
    // spending most of that 0.075 gap on the background it sits over. At /25 it
    // landed ~0.190 — a step too small to read as a group at all.
    <div className="flex items-center gap-0.5 rounded-xl border border-sidebar-border/70 bg-sidebar-accent p-1 transition-colors hover:border-sidebar-border hover:brightness-110">
      {/* On a phone, Search lives up here — the bottom bar is the role's own places (MobileCompanionNav). */}
      <button
        type="button"
        onClick={openCommandMenu}
        aria-label="Search"
        className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:text-foreground md:hidden"
      >
        <Search className="size-3.5" />
      </button>
      {/* Customers' birthdays today (lib/birthdaysServer.ts) — only on a day there are some; colour and a count, quiet. */}
      {birthdaysToday > 0 && (
        <Link
          href="/birthdays"
          aria-label={`${birthdaysToday} customer birthday${birthdaysToday === 1 ? "" : "s"} today`}
          title="Customer birthdays today"
          className="flex h-7 min-w-7 items-center justify-center gap-0.5 rounded-lg px-1 text-primary"
        >
          <Cake className="size-3.5" />
          <span className="text-[10px] font-semibold tabular-nums">{birthdaysToday > 99 ? "99+" : birthdaysToday}</span>
        </Link>
      )}
      {/* The bell: @mentions and records you watch. */}
      <Link
        href="/notifications"
        aria-label={unreadNotices > 0 ? `Notifications, ${unreadNotices} unread` : "Notifications"}
        title="Mentions and records you watch"
        className={`flex h-7 min-w-7 items-center justify-center gap-0.5 rounded-lg px-1 ${unreadNotices > 0 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
      >
        {/* Unread shows as colour and a count, not a filled badge: the cluster stays a quiet group. */}
        <Bell className="size-3.5" />
        {unreadNotices > 0 && <span className="text-[10px] font-semibold tabular-nums">{unreadNotices > 99 ? "99+" : unreadNotices}</span>}
      </Link>
      <SidebarHelpSettings isOwner={isOwner} permissions={user.permissions} compact />
      <div className="mx-0.5 h-5 w-px bg-sidebar-border/70" aria-hidden />
      <AccountMenu user={user} isOwner={isOwner} tenantId={tenantId} compact />
    </div>
  );
}

/**
 * The sidebar (redesign, 2026-11-12): the workspace header with its collapse
 * button, "Search or jump to…" (the command palette), Quick actions, then the
 * menu and its footer (Nav). `rail`: the collapsed 72px strip of icons.
 */
function SidebarInner({ user, inboxWaiting = 0, casesWaiting = 0, activitiesOverdue = 0, enabledModules, brand, phone = false, rail = false, onToggleRail }: { user: ShellUser; inboxWaiting?: number; casesWaiting?: number; activitiesOverdue?: number; enabledModules?: string[]; brand?: { logoUrl: string | null; displayName: string }; phone?: boolean; rail?: boolean; onToggleRail?: () => void }) {
  const isOwner = ownsWorkspace(user);
  const name = brand?.displayName ?? "Denago Cape Town";
  const tile = (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary depth-sheen text-base font-bold text-zinc-950 shadow-[inset_0_1px_0_oklch(1_0_0/38%),0_2px_6px_oklch(0_0_0/50%)]">
      {name.trim().charAt(0).toUpperCase() || "D"}
    </span>
  );
  const collapse = onToggleRail && (
    <button
      type="button"
      onClick={onToggleRail}
      aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
      aria-pressed={rail}
      title={rail ? "Expand sidebar" : "Collapse sidebar"}
      className="grid size-11 shrink-0 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground pointer-fine:size-9"
    >
      {rail ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
    </button>
  );
  const badges = { "/inbox": inboxWaiting, "/cases": casesWaiting, "/activities": activitiesOverdue };

  if (rail) {
    return (
      <div className="flex h-full flex-col items-center gap-3 bg-sidebar py-4">
        {tile}
        {collapse}
        <button
          type="button"
          onClick={openCommandMenu}
          aria-label="Search or jump to"
          title="Search or jump to (⌘K)"
          className="depth-recessed grid size-11 shrink-0 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:text-sidebar-accent-foreground"
        >
          <Search className="size-[18px]" />
        </button>
        <Nav rail user={user} isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} badges={badges} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 bg-sidebar px-3 py-4">
      {/* The workspace: its letter, its name, and the collapse button. */}
      <div className="flex items-center gap-3 px-1">
        {tile}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-sidebar-accent-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">Workspace</span>
        </div>
        {collapse}
      </div>

      <button
        type="button"
        onClick={openCommandMenu}
        className="depth-recessed flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-sm text-muted-foreground transition-colors hover:text-sidebar-accent-foreground pointer-fine:min-h-9"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1">Search or jump to…</span>
        <kbd className="depth-key rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">⌘K</kbd>
      </button>
      {/* On the phone, Capture on the bottom bar is the way to start something. */}
      {!phone && <QuickActions isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} />}

      <Nav user={user} isAdmin={isOwner} permissions={user.permissions} enabledModules={enabledModules} badges={badges} phone={phone} />
    </div>
  );
}

const RAIL_KEY = "denago-sidebar-rail";

export default function AppShell({
  user,
  inboxWaiting = 0,
  casesWaiting = 0,
  activitiesOverdue = 0,
  unreadNotices = 0,
  birthdaysToday = 0,
  enabledModules,
  brand,
  weatherCities,
  activityTypes,
  tenantId,
  recordLabels,
  money = DEFAULT_REGIONAL,
  currencies,
  children,
}: {
  user: ShellUser;
  inboxWaiting?: number;
  casesWaiting?: number;
  /** My overdue planned activities (lib/activityAccess.ts), for the Activities badge. */
  activitiesOverdue?: number;
  /** Unread @mentions and watch updates (lib/collaboration.ts), for the bell. */
  unreadNotices?: number;
  /** Customers with a birthday today that this person may open (lib/birthdaysServer.ts), for the cake. */
  birthdaysToday?: number;
  enabledModules?: string[];
  /** The tenant's clock/weather cities, resolved by the (app) layout. */
  weatherCities: WeatherCity[];
  /**
   * The tenant's activity types, resolved by the (app) layout. Optional so every
   * existing test render still compiles; undefined means the built-in seven.
   */
  activityTypes?: ActivityType[];
  tenantId: string;
  /** The workspace brand, resolved from the SESSION's tenant by the (app)
   *  layout. Optional so every existing test render still compiles; undefined
   *  means the built-in assets, which is what an unbranded tenant gets. */
  brand?: { logoUrl: string | null; displayName: string };
  /** What the workspace calls leads, deals and job cards, resolved by the (app) layout. Undefined = the built-in words. */
  recordLabels?: RecordLabels;
  /** The workspace's currency and locale (Settings → Quotes), for money shown in the browser. Undefined = the rand. */
  money?: MoneyFormat;
  /** Currencies a lead or quote may be in (multicurrency module), base first. Undefined = base only. */
  currencies?: string[];
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  // The collapsed rail, remembered per browser (a per-viewer convenience). Read
  // after mount: the server renders the full sidebar, which is the default.
  const [rail, setRail] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only storage, read once after hydration
      if (localStorage.getItem(RAIL_KEY) === "1") setRail(true);
    } catch {}
  }, []);
  const toggleRail = () => {
    setRail((was) => {
      try {
        localStorage.setItem(RAIL_KEY, was ? "0" : "1");
      } catch {}
      return !was;
    });
  };
  // 280px open, 72px as a rail — the top bar and the page start where it ends.
  const offset = rail ? "lg:left-[72px]" : "lg:left-70";
  const pad = rail ? "lg:pl-[72px]" : "lg:pl-70";

  return (
    <TooltipProvider delayDuration={250}>
    <MoneyFormatProvider money={money} currencies={currencies}>
    <ActivityTypesProvider types={activityTypes}>
    <RecordLabelsProvider labels={recordLabels}>
    <SettingsViewerProvider isOwner={ownsWorkspace(user)} isPlatformOwner={user.role === "owner"} permissions={user.permissions} enabledModules={enabledModules}>
    <div className="min-h-screen">
      <CommandMenu isAdmin={ownsWorkspace(user)} isPlatformOwner={user.role === "owner"} permissions={user.permissions} enabledModules={enabledModules} />
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
            wordmarkClassName="text-xs"
          />
        </div>
        <div className="flex w-[7.5rem] shrink-0 justify-end">
          <AccountCluster user={user} isOwner={ownsWorkspace(user)} tenantId={tenantId} unreadNotices={unreadNotices} birthdaysToday={birthdaysToday} />
        </div>
      </header>

      {/* Desktop top bar. Sticky rather than static: these are the controls you
          reach for from anywhere in a long page, and the sidebar footer they came
          from was always on screen. */}
      {/* SUBTLE DEPTH (sidebar redesign, 2026-11-12): on a desktop the page sits on a panel raised off the
          sidebar — 10px down, its top-left corner rounded, a highlight on its edge and a shadow towards the
          sidebar. The sidebar's colour fills the strip above it (and, behind, the corner); the top bar rides
          the panel. */}
      <div aria-hidden className={`pointer-events-none fixed right-0 top-0 -z-30 hidden h-8 bg-sidebar lg:block ${offset}`} />
      <div aria-hidden className={`pointer-events-none fixed bottom-0 right-0 top-2.5 -z-20 hidden rounded-tl-[18px] bg-background depth-panel lg:block ${offset}`} />
      <div aria-hidden className={`pointer-events-none fixed right-0 top-0 z-30 hidden h-2.5 bg-sidebar lg:block ${offset}`} />
      <header className={`fixed right-0 top-2.5 z-30 hidden h-14 items-center gap-4 rounded-tl-[18px] border-b border-sidebar-border bg-background/80 px-5 backdrop-blur-xl lg:flex ${offset}`}>
        <div className="min-w-0 flex-1">
          <ClockWeather cities={weatherCities} />
        </div>
        <ConnectivityIndicator tenantId={tenantId} userId={user.id} />
        <AccountCluster user={user} isOwner={ownsWorkspace(user)} tenantId={tenantId} unreadNotices={unreadNotices} birthdaysToday={birthdaysToday} />
      </header>

      {/* Mobile drawer */}
      <Sheet key={pathname} open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {/* The drawer is the phone's (and a small tablet's) menu: the phone app's sections only (lib/phoneScope.ts). */}
          <SidebarInner user={user} inboxWaiting={inboxWaiting} casesWaiting={casesWaiting} activitiesOverdue={activitiesOverdue} enabledModules={enabledModules} brand={brand} phone />
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
      <aside className={`fixed inset-y-0 left-0 z-40 hidden lg:flex lg:flex-col ${rail ? "w-[72px]" : "w-70"}`}>
        <SidebarInner user={user} inboxWaiting={inboxWaiting} casesWaiting={casesWaiting} activitiesOverdue={activitiesOverdue} enabledModules={enabledModules} brand={brand} rail={rail} onToggleRail={toggleRail} />
      </aside>

      <main className={`relative ${pad}`}>
        <div className={`pointer-events-none fixed inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(circle_at_65%_0%,rgba(249,115,22,.045),transparent_42%)] ${offset}`} />
        {/* No width cap: the page runs to the same edges as the top bar (both lg:px-5). Capped and centred, it sat
            inside the bar on a wide screen — the bar's ends hung out past the content and the two never lined up. */}
        <div className="denago-workspace p-3 pb-24 pt-15 sm:p-4 sm:pb-24 sm:pt-16 lg:p-5 lg:pt-[86px]">
          {/* ClockWeather moved into the top bar — it was already desktop-only
              furniture at the top of the page, so the bar is where it belongs
              and the page keeps the vertical space the bar takes. */}
          {/* On a phone, a page outside the phone app says so first (lib/phoneScope.ts). */}
          <PhoneGate>{children}</PhoneGate>
        </div>
      </main>
    </div>
    </SettingsViewerProvider>
    </RecordLabelsProvider>
    </ActivityTypesProvider>
    </MoneyFormatProvider>
    </TooltipProvider>
  );
}
