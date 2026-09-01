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

function catalogueDefaultCards(): Map<DashboardCardId, CardConfig> {
  const cards: CardConfig[] = DEFAULT_LAYOUT.map((id, index) => ({
    id: `card-${index + 1}`,
    type: "builtin",
    card: id,
    span: cardById(id)?.span ?? 1,
  }));
  return new Map(cards.map((card) => [card.card as DashboardCardId, card]));
}

function place(
  cards: Map<DashboardCardId, CardConfig>,
  id: DashboardCardId,
  span?: 1 | 2 | 3,
): CardConfig {
  const base = cards.get(id);
  if (!base) throw new Error(`Default dashboard card ${id} is missing from the catalogue.`);
  return span ? { ...base, span } : { ...base };
}

function defaultSections(cards: Map<DashboardCardId, CardConfig>): SectionConfig[] {
  return [
    {
      id: "section-alerts",
      columnSpan: 3,
      cards: [place(cards, "system-alerts", 3)],
    },
    {
      id: "section-kpis",
      columnSpan: 3,
      cards: [place(cards, "sales-stats", 3)],
    },
    {
      id: "section-work",
      title: "Work queue",
      columnSpan: 2,
      cards: [place(cards, "sales-agenda", 2), place(cards, "needs-attention", 2)],
    },
    {
      id: "section-context",
      title: "Sales context",
      columnSpan: 1,
      cards: [
        place(cards, "new-leads", 1),
        place(cards, "pipeline-snapshot", 1),
        place(cards, "month-targets", 1),
        place(cards, "out-for-signature", 1),
      ],
    },
    {
      id: "section-recent",
      title: "Recent activity",
      columnSpan: 3,
      cards: [place(cards, "latest-activity", 3)],
    },
    {
      id: "section-service",
      title: "Service operations",
      columnSpan: 3,
      cards: [
        place(cards, "service-stats", 3),
        place(cards, "service-agenda", 2),
        place(cards, "service-due", 1),
      ],
    },
  ];
}

/**
 * A new user's home dashboard is a designed command centre, not a catalogue dump.
 * Every builtin still appears exactly once and the config stays fully editable;
 * the hierarchy comes from groups: context across the top, today's work in the
 * main column, and pipeline/targets in a narrow supporting rail.
 */
export function defaultDashboard(): LoadedDashboard {
  const cards = catalogueDefaultCards();
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
          sections: defaultSections(cards),
        },
      ],
    },
    updatedAt: null,
    dropped: [],
  };
}
