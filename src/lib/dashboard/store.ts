import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { dashboardViewer } from "./data";
import { viewerTenantId } from "./viewerTenant";
import { sharedInTenant } from "./sharedScope";
import {
  CONFIG_VERSION,
  parseConfig,
  slugify,
  type CardConfig,
  type DashboardConfig,
  type SectionConfig,
} from "./config";
import { DEFAULT_LAYOUT, cardById, type DashboardCardId } from "./registry";

export type DashboardSummary = {
  id: string;
  slug: string;
  title: string;
  icon: string | null;
  sortOrder: number;
  shared: boolean;
};

export type LoadedDashboard = {
  shared: boolean;
  id: string | null;
  slug: string;
  title: string;
  icon: string | null;
  sortOrder: number;
  config: DashboardConfig;
  updatedAt: string | null;
  dropped: string[];
};

export const DEFAULT_DASHBOARD_SLUG = "home";
export const DEFAULT_DASHBOARD_TITLE = "Home";

export const dashboardsForViewer = cache(async (): Promise<DashboardSummary[]> => {
  const { user } = await dashboardViewer();
  const tenantId = await viewerTenantId();
  const rows = await prisma.dashboard.findMany({
    where: { OR: [{ userId: user.id }, sharedInTenant(tenantId)] },
    select: {
      id: true,
      slug: true,
      title: true,
      icon: true,
      sortOrder: true,
      userId: true,
      sharedAt: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const seen = new Set<string>();
  const summaries: DashboardSummary[] = [];
  for (const row of [...rows.filter((r) => r.userId === user.id), ...rows.filter((r) => r.userId !== user.id)]) {
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    summaries.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      icon: row.icon,
      sortOrder: row.sortOrder,
      shared: row.userId !== user.id,
    });
  }
  return summaries;
});

export const dashboardBySlug = cache(async (slug: string): Promise<LoadedDashboard | null> => {
  const { user } = await dashboardViewer();
  const path = slugify(slug);
  const SELECT = {
    id: true,
    slug: true,
    title: true,
    icon: true,
    sortOrder: true,
    config: true,
    userId: true,
    updatedAt: true,
  } as const;
  const row =
    (await prisma.dashboard.findFirst({
      where: { userId: user.id, slug: path },
      select: SELECT,
    })) ??
    (await prisma.dashboard.findFirst({
      where: { slug: path, ...sharedInTenant(await viewerTenantId()) },
      select: SELECT,
    }));
  if (!row) return null;
  const { config, dropped } = parseConfig(row.config);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    icon: row.icon,
    sortOrder: row.sortOrder,
    shared: row.userId !== user.id,
    config,
    updatedAt: row.updatedAt.toISOString(),
    dropped,
  };
});

function defaultCard(id: DashboardCardId, span?: 1 | 2 | 3): CardConfig {
  const index = DEFAULT_LAYOUT.indexOf(id);
  return {
    id: `card-${index + 1}`,
    type: "builtin",
    card: id,
    // A builtin has a catalogue width, but the command-centre composition may
    // deliberately narrow it inside a one-column context rail. Width is therefore
    // a property of the card UNTIL the layout gives it a stronger constraint.
    span: span ?? cardById(id)?.span ?? 1,
  };
}

function defaultSections(): SectionConfig[] {
  return [
    // Quiet system warnings stay at the very top and disappear when healthy.
    {
      id: "section-alerts",
      columnSpan: 3,
      cards: [defaultCard("system-alerts", 3)],
    },
    // One uninterrupted KPI band. It establishes context without becoming the
    // page's dominant interaction surface.
    {
      id: "section-kpis",
      columnSpan: 3,
      cards: [defaultCard("sales-stats", 3)],
    },
    // The working column: what needs doing now. This is intentionally two thirds
    // of the desktop canvas so the agenda no longer competes with tiny widgets.
    {
      id: "section-work",
      title: "Work queue",
      columnSpan: 2,
      cards: [defaultCard("sales-agenda", 2), defaultCard("needs-attention", 2)],
    },
    // The context rail: useful business state, never the visual hero. Every card
    // is one column here even if its standalone catalogue width is larger.
    {
      id: "section-context",
      title: "Sales context",
      columnSpan: 1,
      cards: [
        defaultCard("new-leads", 1),
        defaultCard("pipeline-snapshot", 1),
        defaultCard("month-targets", 1),
        defaultCard("out-for-signature", 1),
      ],
    },
    {
      id: "section-recent",
      title: "Recent activity",
      columnSpan: 3,
      cards: [defaultCard("latest-activity", 3)],
    },
    // Automotive-only cards keep their own group and disappear wholesale as
    // their module/permission gates remove the cards from the rendered slots.
    {
      id: "section-service",
      title: "Service operations",
      columnSpan: 3,
      cards: [
        defaultCard("service-stats", 3),
        defaultCard("service-agenda", 2),
        defaultCard("service-due", 1),
      ],
    },
  ];
}

/**
 * A new user's home dashboard is a designed command centre, not a catalogue dump.
 *
 * Every builtin still appears exactly once and the config stays fully editable;
 * the difference is that the default now expresses hierarchy through sections:
 * KPIs establish context, today's work owns the main column, and pipeline/targets
 * sit in a narrow supporting rail. A user who customises the page takes control
 * of this ordinary config and may rearrange it like any other dashboard.
 */
export function defaultDashboard(): LoadedDashboard {
  return {
    id: null,
    shared: false,
    slug: DEFAULT_DASHBOARD_SLUG,
    title: DEFAULT_DASHBOARD_TITLE,
    icon: null,
    sortOrder: 0,
    config: {
      version: CONFIG_VERSION,
      views: [
        {
          id: "view-home",
          title: DEFAULT_DASHBOARD_TITLE,
          path: DEFAULT_DASHBOARD_SLUG,
          columns: 3,
          sections: defaultSections(),
        },
      ],
    },
    updatedAt: null,
    dropped: [],
  };
}
