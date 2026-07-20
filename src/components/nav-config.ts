import {
  LayoutDashboard,
  ChartColumnIncreasing,
  Target,
  MessageSquare,
  CalendarDays,
  SquareKanban,
  FileText,
  FolderOpen,
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
  LifeBuoy,
  TrendingUp,
  ScrollText,
  GitBranch,
  ShieldEllipsis,
  Building2,
  HeartPulse,
  Gift,
  PenLine,
  Radar,
  type LucideIcon,
} from "lucide-react";

export type NavLink = { href: string; label: string; icon: LucideIcon };
export type NavGroup = { key: string; label: string; links: NavLink[] };

export function buildNav(
  modules: string,
  isAdmin: boolean,
  permissionList: string[] = []
) {
  const mods = new Set(modules.split(",").map((m) => m.trim()).filter(Boolean));
  const permissions = new Set(permissionList);
  const hasModule = (id: string) => isAdmin || mods.has(id);
  const can = (...keys: string[]) => isAdmin || keys.some((key) => permissions.has(key));

  const topLinks: NavLink[] = [{ href: "/", label: "Dashboard", icon: LayoutDashboard }];
  if (can("reports.view", "reports.view_all", "reports.view_team")) {
    topLinks.push({ href: "/reports", label: "Reports", icon: ChartColumnIncreasing });
    topLinks.push({ href: "/targets", label: "Targets", icon: Target });
  }
  if (can("forecast.view", "forecast.manage")) {
    topLinks.push({ href: "/forecast", label: "Forecast", icon: TrendingUp });
  }

  const groups: NavGroup[] = [];

  const socialLinks: NavLink[] = [];
  if (can("inbox.view", "inbox.reply") || (permissionList.length === 0 && hasModule("inbox"))) {
    socialLinks.push({ href: "/inbox", label: "Inbox", icon: MessageSquare });
  }
  if (socialLinks.length) groups.push({ key: "social", label: "Social", links: socialLinks });

  const crmLinks: NavLink[] = [];
  if (can("activities.view", "activities.manage")) crmLinks.push({ href: "/calendar", label: "Calendar", icon: CalendarDays });
  if (can("leads.view_all", "leads.view_owned")) crmLinks.push({ href: "/leads", label: "Leads", icon: SquareKanban });
  if (can("quotes.view_all", "quotes.view_owned")) crmLinks.push({ href: "/quotes", label: "Quotes", icon: FileText });
  if (isAdmin) crmLinks.push({ href: "/signatures", label: "Signatures", icon: PenLine });
  if (can("deliveries.view", "deliveries.manage")) crmLinks.push({ href: "/deliveries", label: "Deliveries", icon: Truck });
  if (can("contacts.view_all", "contacts.view_owned")) crmLinks.push({ href: "/contacts", label: "Contacts", icon: Users });
  if (can("contacts.view_all", "contacts.view_owned")) crmLinks.push({ href: "/fleets", label: "Fleets", icon: Building2 });
  if (can("activities.view", "activities.manage")) crmLinks.push({ href: "/activities", label: "Activities", icon: ListChecks });
  if (can("cases.view_all", "cases.view_owned")) crmLinks.push({ href: "/cases", label: "Customer Cases", icon: Ticket });
  if (can("contacts.view_all", "contacts.view_owned")) crmLinks.push({ href: "/health", label: "Customer Health", icon: HeartPulse });
  if (can("documents.view_all", "documents.view_owned", "documents.upload", "documents.manage", "document_templates.manage")) {
    crmLinks.push({ href: "/documents", label: "Documents", icon: FolderOpen });
  }
  if (crmLinks.length) groups.push({ key: "crm", label: "CRM", links: crmLinks });

  const marketingLinks: NavLink[] = [];
  if (can("campaigns.view", "campaigns.manage")) marketingLinks.push({ href: "/campaigns", label: "Campaigns", icon: Megaphone });
  if (can("surveys.view", "surveys.manage")) marketingLinks.push({ href: "/surveys", label: "Surveys", icon: ClipboardList });
  if (can("contacts.view_all", "contacts.view_owned")) marketingLinks.push({ href: "/referrals", label: "Referrals", icon: Gift });
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
  if (can("journeys.manage")) automationLinks.push({ href: "/automations", label: "Automations", icon: Zap });
  if (isAdmin) {
    automationLinks.push({ href: "/chatbot", label: "Chatbot", icon: Bot });
    automationLinks.push({ href: "/bot-builder", label: "Flow builder", icon: Network });
    automationLinks.push({ href: "/competitors", label: "Competitors", icon: Radar });
  }
  if (automationLinks.length) groups.push({ key: "automation", label: "Automation", links: automationLinks });

  if (can("cases.manage")) {
    groups.push({
      key: "helpdesk",
      label: "Help desk",
      links: [{ href: "/settings/helpdesk", label: "Help desk", icon: LifeBuoy }],
    });
  }

  const governanceLinks: NavLink[] = [];
  if (can("audit.view")) governanceLinks.push({ href: "/audit", label: "Audit log", icon: ScrollText });
  if (can("pipelines.view", "pipelines.manage")) governanceLinks.push({ href: "/settings/pipelines", label: "Pipelines", icon: GitBranch });
  if (can("roles.view", "roles.manage", "teams.view", "teams.manage")) governanceLinks.push({ href: "/settings/access", label: "Access & roles", icon: ShieldEllipsis });
  if (can("document_templates.manage")) governanceLinks.push({ href: "/document-studio", label: "Document Studio", icon: FileText });
  if (governanceLinks.length) groups.push({ key: "governance", label: "Governance", links: governanceLinks });

  return { topLinks, groups };
}

export function flatNav(modules: string, isAdmin: boolean, permissions: string[] = []): NavLink[] {
  const { topLinks, groups } = buildNav(modules, isAdmin, permissions);
  return [...topLinks, ...groups.flatMap((group) => group.links)];
}
