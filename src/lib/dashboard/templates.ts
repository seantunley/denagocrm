/**
 * ROLE TEMPLATES — ready-made dashboards built from the existing catalogue
 * (brief §8: "role-based dashboard templates for sales, operations, managers and
 * owners").
 *
 * A template is NOT a second dashboard system. It is a `DashboardConfig` made of
 * builtin cards from ./registry.ts, served exactly the way the Home default is:
 * GENERATED, with nothing written, until the person changes something — at which
 * point `takeControl(slug)` materialises it as their own row and the ordinary
 * editor takes over. Every card still runs its own permission, module and record
 * checks against whoever is looking, so a template confers nothing; `audience`
 * only decides whom the switcher OFFERS it to, so a rep is not handed a
 * management screen that would be mostly empty for them.
 *
 * PURE — no Prisma, no `server-only` — so the "only registered cards" and
 * "fits the caps" rules are testable directly.
 */
import type { PermissionKey } from "@/lib/permissions";
import { CONFIG_VERSION, type DashboardConfig } from "./config";
import { cardById, type DashboardCardId } from "./registry";

export type DashboardTemplate = {
  /** The dashboard's address, /d/<slug>. */
  slug: string;
  title: string;
  /** Who it is for, in words, for the help article. */
  audience: string;
  /** ANY of these offers the template. The cards gate themselves regardless. */
  permissions: readonly PermissionKey[];
  /** In order. Widths come from the catalogue, as for every builtin card. */
  cards: readonly DashboardCardId[];
};

const MANAGEMENT: readonly PermissionKey[] = ["reports.view", "reports.view_all", "reports.view_team"];

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  {
    slug: "command-centre",
    title: "Command Centre",
    audience: "Owners",
    permissions: MANAGEMENT,
    cards: [
      "system-alerts",
      "cc-headlines",
      "cc-revenue-trend",
      "cc-operations",
      "pipeline-snapshot",
      "cc-forecast",
      "cc-exceptions",
      "cc-team-workload",
      "cc-top-risks",
      "month-targets",
    ],
  },
  {
    slug: "team",
    title: "Team",
    audience: "Managers",
    permissions: MANAGEMENT,
    cards: ["cc-headlines", "cc-exceptions", "cc-team-workload", "cc-top-risks", "cc-forecast", "pipeline-snapshot", "month-targets"],
  },
  {
    slug: "sales-dashboard",
    title: "Sales",
    audience: "Sales",
    permissions: ["leads.view_all", "leads.view_owned"],
    cards: ["sales-stats", "pipeline-snapshot", "new-leads", "needs-attention", "month-targets", "cc-top-risks", "out-for-signature", "sales-agenda", "cc-forecast"],
  },
  {
    slug: "operations",
    title: "Operations",
    audience: "Operations",
    permissions: ["deliveries.view", "deliveries.manage", "jobcards.view_all", "jobcards.view_owned", "cases.view_all", "cases.view_owned"],
    cards: ["service-stats", "cc-operations", "service-agenda", "service-due", "out-for-signature"],
  },
];

export function templateBySlug(slug: string): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find((template) => template.slug === slug);
}

/** Does this viewer get the template offered? */
export function offersTemplate(template: DashboardTemplate, permissions: ReadonlySet<string>): boolean {
  return template.permissions.some((key) => permissions.has(key));
}

/**
 * The template as a config: one tab, one full-width section, its cards in order.
 * Built fresh per call — config.ts's budget helpers mutate what they are handed.
 */
export function templateConfig(template: DashboardTemplate): DashboardConfig {
  return {
    version: CONFIG_VERSION,
    title: template.title,
    views: [
      {
        id: `view-${template.slug}`.slice(0, 40),
        title: template.title,
        path: template.slug,
        columns: 3,
        sections: [
          {
            id: `section-${template.slug}`.slice(0, 40),
            columnSpan: 3,
            cards: template.cards.map((id, index) => ({
              id: `card-${index + 1}`,
              type: "builtin" as const,
              card: id,
              span: cardById(id)?.span ?? 1,
            })),
          },
        ],
      },
    ],
  };
}
