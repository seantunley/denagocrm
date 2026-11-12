import {
  LayoutDashboard,
  House,
  ChartColumnIncreasing,
  Target,
  MessageSquare,
  CalendarDays,
  SquareKanban,
  FileText,
  FolderOpen,
  Library,
  Truck,
  Wallet,
  Users,
  ListChecks,
  Megaphone,
  ClipboardList,
  Package,
  CalendarClock,
  CarFront,
  Clock4,
  ShieldCheck,
  Wrench,
  Cog,
  Zap,
  Bot,
  Network,
  Ticket,
  TrendingUp,
  ScrollText,
  Building2,
  HeartPulse,
  Gift,
  PenLine,
  Radar,
  Route,
  Hammer,
  Sun,
  Cake,
  type LucideIcon,
} from "lucide-react";
import { isPathEnabled } from "@/lib/modules/registry";
import { DaxIcon } from "@/components/DaxIcon";

/** `keywords`: other words search should find the link by (e.g. an old name). */
export type NavLink = { href: string; label: string; icon: LucideIcon; keywords?: string[] };
/** A group's heading carries its icon; the links inside it are text (sidebar redesign, 2026-11-12). */
export type NavGroup = { key: string; label: string; icon: LucideIcon; links: NavLink[] };

/**
 * The nav is built from RBAC alone. It used to also take the per-user module
 * CSV, which made a link's visibility and the page's own guard answer to two
 * different systems — a link could show for a user the proxy then redirected
 * away (and vice versa). `enabledModules` is the unrelated TENANT feature pack
 * (src/lib/modules/registry.ts): what the workspace has switched on, not what
 * this user may do.
 */
export function buildNav(
  isAdmin: boolean,
  permissionList: string[] = [],
  enabledModules?: ReadonlySet<string>,
  /** The workspace's own names for menu links, by href (navLabelOverrides in lib/recordLabels.ts). */
  labels: Record<string, string> = {},
) {
  const permissions = new Set(permissionList);
  const can = (...keys: string[]) => isAdmin || keys.some((key) => permissions.has(key));

  /*
   * SIDEBAR REDESIGN (sidebar-reorganisation-plan.md, 2026-11-12): in the order
   * work happens in a dealership. Pinned = where you start and what is waiting
   * (Inbox and Help desk keep their counts in sight); then Sales, Customers,
   * Service, Marketing, Insights, Automation and Admin. Only WHERE a link sits
   * changed — every `can(…)` below is the one it had before, word for word, and
   * tests/sidebarRedesign.test.ts holds the before/after link sets per role.
   */
  const topLinks: NavLink[] = [{ href: "/", label: "Home", icon: House, keywords: ["start", "do next", "overview"] }];
  if (can("leads.view_all", "leads.view_owned")) topLinks.push({ href: "/today", label: "Today", icon: Sun, keywords: ["lead score", "who to call", "next"] });
  // Public comments are the inbox's Comments tab (one inbox, batch 6).
  if (can("inbox.view", "inbox.reply")) topLinks.push({ href: "/inbox", label: "Inbox", icon: MessageSquare, keywords: ["social", "messages", "whatsapp", "facebook"] });
  if (can("cases.view_all", "cases.view_owned")) topLinks.push({ href: "/cases", label: "Help desk", icon: Ticket, keywords: ["cases", "tickets", "support"] });
  if (can("activities.view", "activities.manage")) topLinks.push({ href: "/calendar", label: "Calendar", icon: CalendarDays });

  const groups: NavGroup[] = [];

  const salesLinks: NavLink[] = [];
  if (can("leads.view_all", "leads.view_owned")) salesLinks.push({ href: "/leads", label: labels["/leads"] ?? "Leads", icon: SquareKanban, keywords: ["leads"] });
  if (can("quotes.view_all", "quotes.view_owned")) salesLinks.push({ href: "/quotes", label: "Quotes", icon: FileText });
  if (can("activities.view", "activities.manage")) salesLinks.push({ href: "/test-drives", label: "Test Drives", icon: Route });
  if (can("signing.view", "signing.manage")) salesLinks.push({ href: "/signatures", label: "Signatures", icon: PenLine });
  if (can("deliveries.view", "deliveries.manage")) salesLinks.push({ href: "/deliveries", label: "Deliveries", icon: Truck });
  // The money side of the board (2026-11-11): the same door — deliveries.* — as the board it came off.
  if (can("deliveries.view", "deliveries.manage")) salesLinks.push({ href: "/invoices", label: "Invoices", icon: Wallet, keywords: ["xero", "owing", "paid", "deposit", "accounts"] });
  if (can("stock.view", "stock.manage")) salesLinks.push({ href: "/stock", label: "Stock", icon: Package, keywords: ["inventory", "units"] });
  if (salesLinks.length) groups.push({ key: "sales", label: "Sales", icon: TrendingUp, links: salesLinks });

  const customerLinks: NavLink[] = [];
  if (can("contacts.view_all", "contacts.view_owned")) customerLinks.push({ href: "/contacts", label: "Contacts", icon: Users });
  // fleets.* — the same rule ROUTE_RULES applies at the edge and requireRoute
  // applies on the page, so this link cannot appear for someone /fleets bounces.
  if (can("fleets.view", "fleets.manage")) customerLinks.push({ href: "/fleets", label: "Fleets", icon: Building2 });
  if (can("activities.view", "activities.manage")) customerLinks.push({ href: "/activities", label: "Activities", icon: ListChecks });
  if (can("contacts.view_all", "contacts.view_owned")) customerLinks.push({ href: "/health", label: "Customer Health", icon: HeartPulse });
  if (can("contacts.view_all", "contacts.view_owned")) customerLinks.push({ href: "/birthdays", label: "Birthdays", icon: Cake, keywords: ["birthday", "birthdays", "dob"] });
  // One entry for Documents and the Library merged into it. The page opens
  // library-only access straight on the Library, the only part it can see.
  if (can("documents.view_all", "documents.view_owned", "documents.upload", "documents.manage", "document_templates.manage", "library.view", "library.manage")) {
    customerLinks.push({ href: "/documents", label: "Documents", icon: FolderOpen, keywords: ["document library", "brochures", "price lists", "spec sheets"] });
  }
  if (customerLinks.length) groups.push({ key: "customers", label: "Customers", icon: Users, links: customerLinks });

  const serviceLinks: NavLink[] = [];
  if (can("activities.view", "activities.manage") && can("jobcards.view_all", "jobcards.view_owned")) {
    serviceLinks.push({ href: "/workshop-calendar", label: "Workshop calendar", icon: CalendarClock, keywords: ["workshop cal", "bookings"] });
  }
  if (can("jobcards.view_all", "jobcards.view_owned")) serviceLinks.push({ href: "/jobcards", label: labels["/jobcards"] ?? "Job Cards", icon: Wrench, keywords: ["job cards"] });
  if (can("vehicles.view_all", "vehicles.view_owned")) {
    serviceLinks.push({ href: "/vehicles", label: "Vehicles", icon: CarFront });
    serviceLinks.push({ href: "/service-due", label: "Service Due", icon: Clock4 });
  }
  if (can("warranty.view", "warranty.manage")) serviceLinks.push({ href: "/warranty", label: "Warranty", icon: ShieldCheck });
  if (can("parts.view", "parts.manage")) serviceLinks.push({ href: "/parts", label: "Parts", icon: Cog });
  if (serviceLinks.length) groups.push({ key: "service", label: "Service", icon: Wrench, links: serviceLinks });

  // Also the Marketing workspace's own tabs (marketing-workspace-nav.ts). Overview and Survey insights stay as
  // links until each folds into its parent screen (plan stage 4): Overview → Campaigns, Survey insights → Surveys.
  const marketingLinks: NavLink[] = [];
  if (can("campaigns.view", "campaigns.manage")) {
    marketingLinks.push({ href: "/marketing/overview", label: "Overview", icon: LayoutDashboard, keywords: ["marketing overview"] });
    marketingLinks.push({ href: "/marketing/campaigns", label: "Campaigns", icon: Megaphone });
    marketingLinks.push({ href: "/marketing/audiences", label: "Audiences", icon: Users });
    marketingLinks.push({ href: "/marketing/templates", label: "Templates", icon: Library });
    marketingLinks.push({ href: "/marketing/calendar", label: "Calendar", icon: CalendarDays, keywords: ["marketing calendar", "content calendar"] });
  }
  if (can("surveys.view", "surveys.manage")) {
    marketingLinks.push({ href: "/marketing/surveys", label: "Surveys", icon: ClipboardList });
    marketingLinks.push({ href: "/marketing/surveys/insights", label: "Survey insights", icon: HeartPulse });
  }
  if (can("referrals.view", "referrals.manage")) marketingLinks.push({ href: "/referrals", label: "Referrals", icon: Gift });
  if (marketingLinks.length) groups.push({ key: "marketing", label: "Marketing", icon: Megaphone, links: marketingLinks });

  const insightLinks: NavLink[] = [];
  // The dashboards — charts and cards people arranged — have their own entry, so
  // moving them off the home screen did not move them out of sight.
  insightLinks.push({ href: "/d/home", label: "Dashboards", icon: LayoutDashboard, keywords: ["dashboard", "charts", "cards", "widgets"] });
  if (can("reports.view", "reports.view_all", "reports.view_team")) {
    insightLinks.push({ href: "/reports", label: "Reports", icon: ChartColumnIncreasing });
    insightLinks.push({ href: "/targets", label: "Targets", icon: Target });
  }
  if (can("forecast.view", "forecast.manage")) insightLinks.push({ href: "/forecast", label: "Forecast", icon: TrendingUp });
  if (can("jobcards.view_all", "jobcards.view_owned")) insightLinks.push({ href: "/jobcards/insights", label: "Workshop Insights", icon: TrendingUp });
  if (isAdmin) insightLinks.push({ href: "/competitors", label: "Competitors", icon: Radar });
  groups.push({ key: "insights", label: "Insights", icon: ChartColumnIncreasing, links: insightLinks });

  const automationLinks: NavLink[] = [];
  // /automations is now a redirect to /journeys (the AutomationRule engine is
  // retired) — link the survivor directly rather than sending every click
  // through a bounce.
  if (can("journeys.manage")) automationLinks.push({ href: "/journeys", label: "Journeys", icon: Zap });
  if (isAdmin) {
    automationLinks.push({ href: "/chatbot", label: "Chatbot", icon: Bot });
    // Kept until it folds into Chatbot as a tab (plan stage 4).
    automationLinks.push({ href: "/bot-builder", label: "Flow builder", icon: Network });
  }
  if (automationLinks.length) groups.push({ key: "automation", label: "Automation", icon: Zap, links: automationLinks });

  const adminLinks: NavLink[] = [];
  if (can("document_templates.manage", "docbuilder.view", "docbuilder.manage")) adminLinks.push({ href: "/document-studio", label: "Document Studio", icon: FileText });
  if (can("contacts.view_all", "contacts.view_owned")) adminLinks.push({ href: "/data-quality", label: "Data quality", icon: ShieldCheck, keywords: ["duplicates", "missing details", "data quality", "clean up"] });
  if (can("audit.view")) adminLinks.push({ href: "/audit", label: "Audit log", icon: ScrollText });
  // `isAdmin`, not `can(...)`, to match ROUTE_RULES' `{ prefix: "/repairs",
  // owner: true }`. A `can(...)` list here would be a second, independently
  // authored answer to a question the route table already answers.
  if (isAdmin) adminLinks.push({ href: "/repairs", label: "Data repairs", icon: Hammer, keywords: ["repairs"] });
  if (adminLinks.length) groups.push({ key: "admin", label: "Admin", icon: ShieldCheck, links: adminLinks });

  // The footer's standing button. Anyone who can see leads, quotes or
  // activities: it only ever shows them what their own lists already would.
  const footerLinks: NavLink[] = [];
  if (can("leads.view_all", "leads.view_owned", "quotes.view_all", "quotes.view_owned", "activities.view", "activities.manage")) {
    footerLinks.push({ href: "/assistant", label: "Ask the CRM", icon: DaxIcon, keywords: ["dax", "assistant", "ai"] });
  }

  if (enabledModules) {
    const visibleTop = topLinks.filter((link) => isPathEnabled(link.href, enabledModules));
    const visibleGroups = groups
      .map((group) => ({ ...group, links: group.links.filter((link) => isPathEnabled(link.href, enabledModules)) }))
      .filter((group) => group.links.length > 0);
    return { topLinks: visibleTop, groups: visibleGroups, footerLinks: footerLinks.filter((link) => isPathEnabled(link.href, enabledModules)) };
  }

  return { topLinks, groups, footerLinks };
}

/** Every link the menu can show this person — pinned, grouped and the footer's — for search and the palette. */
export function allNavLinks(nav: ReturnType<typeof buildNav>): NavLink[] {
  return [...nav.topLinks, ...nav.groups.flatMap((group) => group.links), ...nav.footerLinks];
}

export function flatNav(isAdmin: boolean, permissions: string[] = []): NavLink[] {
  return allNavLinks(buildNav(isAdmin, permissions));
}
