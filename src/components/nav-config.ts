import {
  LayoutDashboard,
  ChartColumnIncreasing,
  Target,
  MessageSquare,
  CalendarDays,
  SquareKanban,
  FileText,
  FolderOpen,
  Library,
  Truck,
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
  type LucideIcon,
} from "lucide-react";
import { isPathEnabled } from "@/lib/modules/registry";

export type NavLink = { href: string; label: string; icon: LucideIcon };
export type NavGroup = { key: string; label: string; links: NavLink[] };

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
) {
  const permissions = new Set(permissionList);
  const can = (...keys: string[]) => isAdmin || keys.some((key) => permissions.has(key));

  const topLinks: NavLink[] = [{ href: "/", label: "Dashboard", icon: LayoutDashboard }];
  if (can("reports.view", "reports.view_all", "reports.view_team")) {
    topLinks.push({ href: "/reports", label: "Reports", icon: ChartColumnIncreasing });
    topLinks.push({ href: "/targets", label: "Targets", icon: Target });
  }
  if (can("forecast.view", "forecast.manage")) topLinks.push({ href: "/forecast", label: "Forecast", icon: TrendingUp });

  const groups: NavGroup[] = [];

  const socialLinks: NavLink[] = [];
  if (can("inbox.view", "inbox.reply")) {
    socialLinks.push({ href: "/inbox", label: "Inbox", icon: MessageSquare });
  }
  if (socialLinks.length) groups.push({ key: "social", label: "Social", links: socialLinks });

  const crmLinks: NavLink[] = [];
  if (can("activities.view", "activities.manage")) crmLinks.push({ href: "/calendar", label: "Calendar", icon: CalendarDays });
  if (can("activities.view", "activities.manage")) crmLinks.push({ href: "/test-drives", label: "Test Drives", icon: Route });
  if (can("leads.view_all", "leads.view_owned")) crmLinks.push({ href: "/leads", label: "Leads", icon: SquareKanban });
  if (can("quotes.view_all", "quotes.view_owned")) crmLinks.push({ href: "/quotes", label: "Quotes", icon: FileText });
  if (can("signing.view", "signing.manage")) crmLinks.push({ href: "/signatures", label: "Signatures", icon: PenLine });
  if (can("deliveries.view", "deliveries.manage")) crmLinks.push({ href: "/deliveries", label: "Deliveries", icon: Truck });
  if (can("contacts.view_all", "contacts.view_owned")) crmLinks.push({ href: "/contacts", label: "Contacts", icon: Users });
  // fleets.* — the same rule ROUTE_RULES applies at the edge and requireRoute
  // applies on the page, so this link cannot appear for someone /fleets bounces.
  if (can("fleets.view", "fleets.manage")) crmLinks.push({ href: "/fleets", label: "Fleets", icon: Building2 });
  if (can("activities.view", "activities.manage")) crmLinks.push({ href: "/activities", label: "Activities", icon: ListChecks });
  if (can("contacts.view_all", "contacts.view_owned")) crmLinks.push({ href: "/health", label: "Customer Health", icon: HeartPulse });
  if (can("documents.view_all", "documents.view_owned", "documents.upload", "documents.manage", "document_templates.manage")) {
    crmLinks.push({ href: "/documents", label: "Documents", icon: FolderOpen });
  }
  if (crmLinks.length) groups.push({ key: "crm", label: "CRM", links: crmLinks });

  if (can("cases.view_all", "cases.view_owned")) {
    groups.push({ key: "helpdesk", label: "Help desk", links: [{ href: "/cases", label: "Help desk", icon: Ticket }] });
  }

  const marketingLinks: NavLink[] = [];
  if (can("campaigns.view", "campaigns.manage")) {
    marketingLinks.push({ href: "/marketing/overview", label: "Overview", icon: LayoutDashboard });
    marketingLinks.push({ href: "/marketing/campaigns", label: "Campaigns", icon: Megaphone });
    marketingLinks.push({ href: "/marketing/calendar", label: "Calendar", icon: CalendarDays });
    marketingLinks.push({ href: "/marketing/audiences", label: "Audiences", icon: Users });
    marketingLinks.push({ href: "/marketing/templates", label: "Templates", icon: Library });
  }
  if (can("surveys.view", "surveys.manage")) {
    marketingLinks.push({ href: "/marketing/surveys", label: "Surveys", icon: ClipboardList });
    marketingLinks.push({ href: "/marketing/surveys/insights", label: "Survey insights", icon: HeartPulse });
  }
  if (can("referrals.view", "referrals.manage")) marketingLinks.push({ href: "/referrals", label: "Referrals", icon: Gift });
  if (marketingLinks.length) groups.push({ key: "marketing", label: "Marketing", links: marketingLinks });

  if (can("stock.view", "stock.manage")) {
    groups.push({ key: "stock", label: "Stock", links: [{ href: "/stock", label: "Stock", icon: Package }] });
  }

  const workshopLinks: NavLink[] = [];
  if (can("activities.view", "activities.manage") && can("jobcards.view_all", "jobcards.view_owned")) {
    workshopLinks.push({ href: "/workshop-calendar", label: "Workshop Cal", icon: CalendarClock });
  }
  if (can("vehicles.view_all", "vehicles.view_owned")) {
    workshopLinks.push({ href: "/vehicles", label: "Vehicles", icon: CarFront });
    workshopLinks.push({ href: "/service-due", label: "Service Due", icon: Clock4 });
  }
  if (can("warranty.view", "warranty.manage")) workshopLinks.push({ href: "/warranty", label: "Warranty", icon: ShieldCheck });
  if (can("jobcards.view_all", "jobcards.view_owned")) workshopLinks.push({ href: "/jobcards", label: "Job Cards", icon: Wrench });
  if (can("jobcards.view_all", "jobcards.view_owned")) workshopLinks.push({ href: "/jobcards/insights", label: "Workshop Insights", icon: TrendingUp });
  if (can("parts.view", "parts.manage")) workshopLinks.push({ href: "/parts", label: "Parts", icon: Cog });
  if (workshopLinks.length) groups.push({ key: "workshop", label: "Workshop", links: workshopLinks });

  const automationLinks: NavLink[] = [];
  // /automations is now a redirect to /journeys (the AutomationRule engine is
  // retired) — link the survivor directly rather than sending every click
  // through a bounce.
  if (can("journeys.manage")) automationLinks.push({ href: "/journeys", label: "Journeys", icon: Zap });
  if (isAdmin) {
    automationLinks.push({ href: "/chatbot", label: "Chatbot", icon: Bot });
    automationLinks.push({ href: "/bot-builder", label: "Flow builder", icon: Network });
    automationLinks.push({ href: "/competitors", label: "Competitors", icon: Radar });
  }
  if (automationLinks.length) groups.push({ key: "automation", label: "Automation", links: automationLinks });

  const platformLinks: NavLink[] = [];
  if (can("library.view", "library.manage")) platformLinks.push({ href: "/library", label: "Document library", icon: Library });
  if (can("document_templates.manage")) platformLinks.push({ href: "/document-studio", label: "Document Studio", icon: FileText });
  if (platformLinks.length) groups.push({ key: "platform", label: "Platform", links: platformLinks });

  const governanceLinks: NavLink[] = [];
  if (can("audit.view")) governanceLinks.push({ href: "/audit", label: "Audit log", icon: ScrollText });
  // `isAdmin`, not `can(...)`, to match ROUTE_RULES' `{ prefix: "/repairs",
  // owner: true }`. A `can(...)` list here would be a second, independently
  // authored answer to a question the route table already answers.
  if (isAdmin) governanceLinks.push({ href: "/repairs", label: "Repairs", icon: Hammer });
  if (governanceLinks.length) groups.push({ key: "governance", label: "Governance", links: governanceLinks });

  if (enabledModules) {
    const visibleTop = topLinks.filter((link) => isPathEnabled(link.href, enabledModules));
    const visibleGroups = groups
      .map((group) => ({ ...group, links: group.links.filter((link) => isPathEnabled(link.href, enabledModules)) }))
      .filter((group) => group.links.length > 0);
    return { topLinks: visibleTop, groups: visibleGroups };
  }

  return { topLinks, groups };
}

export function flatNav(isAdmin: boolean, permissions: string[] = []): NavLink[] {
  const { topLinks, groups } = buildNav(isAdmin, permissions);
  return [...topLinks, ...groups.flatMap((group) => group.links)];
}
