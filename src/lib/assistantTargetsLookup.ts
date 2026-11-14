import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { hasAnyPermission, hasPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { TARGET_METRICS, targetProgress } from "./targetProgress";

/**
 * Sales targets and competitor intelligence for DAX (Sean, 2026-11-14: "DAX must have knowledge of those things,
 * permission based"). Each is held to its page's own rule: /targets needs a reports permission (its layout), and
 * reads lib/targetProgress — the page's own counts; /competitors needs competitors.view and the automation module.
 * The workspace is named in every query. Nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const unavailable = (why: string): Output => ({ rows: [], data: [{ note: why }], truncated: false });
const clip = (s: string | null | undefined, max: number) => {
  const text = (s ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const rands = (cents: number) => Math.round(cents / 100);

/* ── targets ─────────────────────────────────────────────────────────────── */

export async function targetsLookup(user: PermissionUser, args: { period?: string }, now = new Date()): Promise<Output> {
  if (!(await hasAnyPermission(user, "reports.view_all", "reports.view_team", "reports.view"))) return unavailable("This person can't open Targets.");
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const period = args.period && /^\d{4}-\d{2}$/.test(args.period) ? args.period : current;
  const [year, month] = period.split("-").map(Number);
  // The page's month (server-local, as the page counts it); a past month also ends where it ends.
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = period === current ? undefined : new Date(year, month, 1);
  const { targetMap, actuals } = await targetProgress(ownedWriteTenantId(), period, monthStart, monthEnd);
  const goals = TARGET_METRICS.map((metric) => {
    const target = targetMap.get(metric.id) ?? 0;
    const actual = actuals[metric.id];
    const shown = (n: number) => (metric.kind === "money" ? rands(n) : n);
    return target > 0
      ? { goal: metric.label, target: shown(target), actual: shown(actual), stillNeeded: shown(Math.max(0, target - actual)), percent: Math.round((actual / target) * 100), achieved: actual >= target }
      : { goal: metric.label, target: "not set", actual: shown(actual) };
  });
  const set = goals.filter((g) => typeof g.target === "number");
  const daysLeft = period === current ? new Date(year, month, 0).getDate() - now.getDate() : 0;
  return {
    truncated: false,
    data: [{
      period,
      ...(period === current ? { daysLeftInMonth: daysLeft } : period > current ? { note: "A future month: nothing done yet." } : {}),
      goalsSet: set.length,
      goalsAchieved: set.filter((g) => "achieved" in g && g.achieved).length,
      moneyIn: "rands, the base currency (deals in another currency don't count toward a target)",
      howCounted: "New leads = created in the month; sales value = deals marked won whose last update was in the month; deliveries = quotes delivered; services = service records dated in the month — as the Targets page counts them. Targets are for the whole business, not per person.",
      goals,
    }],
    rows: [{ label: `Targets ${period}`, detail: `${set.filter((g) => "achieved" in g && g.achieved).length} of ${set.length} goals achieved`, href: "/targets" }],
  };
}

/* ── competitors ─────────────────────────────────────────────────────────── */

const TIER = ["", "critical", "important", "watch"];

export async function competitorsLookup(user: PermissionUser, args: { name?: string }): Promise<Output> {
  if (!(await isModuleEnabled("automation"))) return unavailable("Competitor intelligence is switched off in this workspace.");
  if (!(await hasPermission(user, "competitors.view"))) return unavailable("This person can't open competitor intelligence.");
  const tenantId = ownedWriteTenantId();
  const named = args.name?.trim();
  const competitors = await prisma.competitor.findMany({
    where: { tenantId, deletedAt: null, ...(named ? { name: { contains: named, mode: "insensitive" } } : {}) },
    orderBy: [{ tier: "asc" }, { name: "asc" }],
    take: 25,
    select: {
      id: true, name: true, website: true, description: true, notes: true, tier: true, status: true,
      _count: { select: { sources: true } },
      changes: { where: { status: "new" }, select: { materiality: true } },
    },
  });
  if (!competitors.length) return unavailable(named ? `No competitor matches "${named}".` : "No competitors are being watched yet.");
  // One named: its recent changes and its latest research brief, as its own page shows them.
  const one = named && competitors.length === 1 ? competitors[0] : null;
  const detail = one
    ? await Promise.all([
        prisma.competitorChange.findMany({
          where: { tenantId, competitorId: one.id, materiality: { not: "noise" } },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { createdAt: true, status: true, materiality: true, category: true, summary: true, source: { select: { label: true } } },
        }),
        prisma.competitorBrief.findFirst({
          where: { tenantId, competitorId: one.id, kind: "research" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true, headline: true, body: true },
        }),
      ])
    : null;
  return {
    truncated: competitors.length === 25,
    data: [{
      note: "Competitor intelligence: watched websites, the changes found on them, and AI research briefs. It is not linked to deals.",
      competitors: competitors.map((c) => ({
        competitor: c.name,
        tier: TIER[c.tier] ?? String(c.tier),
        status: c.status === "active" ? "monitoring" : "archived",
        website: c.website,
        about: clip(c.description, 300),
        notes: clip(c.notes, 400) || null,
        sourcesWatched: c._count.sources,
        changesToReview: c.changes.length,
        criticalToReview: c.changes.filter((ch) => ch.materiality === "critical").length,
      })),
      ...(detail
        ? {
            recentChanges: detail[0].map((ch) => ({ found: day(ch.createdAt), materiality: ch.materiality, category: ch.category, page: ch.source.label, status: ch.status === "new" ? "to review" : ch.status, summary: clip(ch.summary, 300) })),
            latestBrief: detail[1] ? { written: day(detail[1].createdAt), headline: detail[1].headline, body: clip(detail[1].body, 1500) } : null,
          }
        : {}),
    }],
    rows: competitors.slice(0, 8).map((c) => ({ label: c.name, detail: `${TIER[c.tier] ?? c.tier} · ${c.changes.length} to review`, href: `/competitors/${c.id}` })),
  };
}
