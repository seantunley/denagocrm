import {
  LayoutDashboard,
  ChartColumnIncreasing,
  Target,
  MessageSquare,
  CalendarDays,
  SquareKanban,
  FileText,
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
  KeyRound,
  TrendingUp,
  ScrollText,
  GitBranch,
  ShieldEllipsis,
  type LucideIcon,
} from "lucide-react";

export type NavLink = { href: string; label: string; icon: LucideIcon };
export type NavGroup = { key: string; label: string; links: NavLink[] };

export function buildNav(modules: string, isAdmin: boolean) {
  const mods = new Set(
    modules.split(",").map((m) => m.trim()).filter(Boolean)
  );
  const has = (m: string) => isAdmin || mods.has(m);

  const topLinks: NavLink[] = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    ...(has("reports")
      ? [
          { href: "/reports", label: "Reports", icon: ChartColumnIncreasing },
          { href: "/targets", label: "Targets", icon: Target },
          { href: "/forecast", label: "Forecast", icon: TrendingUp },
        ]
      : []),
  ];

  const groups: NavGroup[] = [];

  if (has("inbox")) {
    groups.push({
      key: "social",
      label: "Social",
      links: [{ href: "/inbox", label: "Inbox", icon: MessageSquare }],
    });
  }

  if (has("crm")) {
    groups.push({
      key: "crm",
      label: "CRM",
      links: [
        { href: "/calendar", label: "Calendar", icon: CalendarDays },
        { href: "/leads", label: "Leads", icon: SquareKanban },
        { href: "/quotes", label: "Quotes", icon: FileText },
        { href: "/deliveries", label: "Deliveries", icon: Truck },
        { href: "/contacts", label: "Contacts", icon: Users },
        { href: "/activities", label: "Activities", icon: ListChecks },
        { href: "/cases", label: "Customer Cases", icon: Ticket },
      ],
    });
    groups.push({
      key: "marketing",
      label: "Marketing",
      links: [
        { href: "/campaigns", label: "Campaigns", icon: Megaphone },
        { href: "/surveys", label: "Surveys", icon: ClipboardList },
      ],
    });
    groups.push({
      key: "stock",
      label: "Stock",
      links: [{ href: "/stock", label: "Stock", icon: Package }],
    });
  }

  if (has("workshop")) {
    groups.push({
      key: "workshop",
      label: "Workshop",
      links: [
        { href: "/workshop-calendar", label: "Workshop Cal", icon: CalendarClock },
        ...(!has("crm")
          ? [{ href: "/contacts", label: "Contacts", icon: Users }]
          : []),
        { href: "/vehicles", label: "Vehicles", icon: CarFront },
        { href: "/service-due", label: "Service Due", icon: Clock4 },
        { href: "/warranty", label: "Warranty", icon: ShieldCheck },
        { href: "/jobcards", label: "Job Cards", icon: Wrench },
        { href: "/parts", label: "Parts", icon: Cog },
      ],
    });
  }

  if (isAdmin) {
    groups.push({
      key: "automation",
      label: "Automation",
      links: [
        { href: "/automations", label: "Automations", icon: Zap },
        { href: "/chatbot", label: "Chatbot", icon: Bot },
        { href: "/bot-builder", label: "Flow builder", icon: Network },
      ],
    });
    groups.push({
      key: "portal-admin",
      label: "Customer Portal",
      links: [{ href: "/settings/portal-access", label: "Portal access", icon: KeyRound }],
    });
    groups.push({
      key: "governance",
      label: "Governance",
      links: [
        { href: "/audit", label: "Audit log", icon: ScrollText },
        { href: "/settings/pipelines", label: "Pipelines", icon: GitBranch },
        { href: "/settings/access", label: "Access & roles", icon: ShieldEllipsis },
      ],
    });
  }

  return { topLinks, groups };
}

/** Flat list of every destination — for the command palette. */
export function flatNav(modules: string, isAdmin: boolean): NavLink[] {
  const { topLinks, groups } = buildNav(modules, isAdmin);
  return [...topLinks, ...groups.flatMap((g) => g.links)];
}
