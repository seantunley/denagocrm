import Link from "next/link";
import { ArrowLeft, BadgeDollarSign, Gauge, RotateCcw, ShieldCheck, TrendingUp } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireAnyPermission, getAccessibleJobCardIds } from "@/lib/permissions";
import { jobProfit, totalLoggedHours } from "@/lib/workshop";
import { formatZAR } from "@/lib/format";
import { WorkspaceHero } from "@/components/workspace-hero";
import { stageMeta, isTerminalStage } from "@/lib/workshop-constants";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

export default async function WorkshopInsightsPage() {
  const user = await requireAnyPermission("jobcards.view_all", "jobcards.view_owned");
  const ids = await getAccessibleJobCardIds(user);
  const scope = ids === null ? {} : { id: { in: ids } };
  const now = new Date();
  const since90 = new Date(now.getTime() - 90 * DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);

  const [active, completed, entries] = await Promise.all([
    prisma.jobCard.findMany({
      where: { ...scope, deletedAt: null, status: { notIn: ["collected", "cancelled"] } },
      include: { items: { include: { part: true } } },
    }),
    prisma.jobCard.findMany({
      where: { ...scope, deletedAt: null, completedAt: { gte: since90 } },
      include: { items: { include: { part: true } } },
    }),
    prisma.jobCardTimeEntry.findMany({
      where: { jobCard: { ...scope, deletedAt: null }, startedAt: { gte: since30 } },
      include: { technician: true },
    }),
  ]);

  // WIP: billed value tied up in active jobs.
  const wipCents = active.reduce((s, j) => s + jobProfit(j.items, j.subCostCents).revenueCents, 0);

  // Profitability over completed jobs (last 90 days).
  const totals = completed.reduce(
    (acc, j) => {
      const p = jobProfit(j.items, j.subCostCents);
      acc.revenue += p.revenueCents;
      acc.cost += p.costCents;
      acc.profit += p.profitCents;
      acc.warranty += j.warrantyRecoveredCents;
      if (j.comebackOfId) acc.comebacks += 1;
      return acc;
    },
    { revenue: 0, cost: 0, profit: 0, warranty: 0, comebacks: 0 },
  );
  const marginPct = totals.revenue > 0 ? Math.round((totals.profit / totals.revenue) * 100) : 0;
  const comebackRate = completed.length > 0 ? Math.round((totals.comebacks / completed.length) * 100) : 0;

  // Technician productivity (last 30 days).
  const byTech = new Map<string, { name: string; hours: number }>();
  for (const e of entries) {
    const key = e.technicianId;
    const cur = byTech.get(key) ?? { name: e.technician?.name ?? "—", hours: 0 };
    cur.hours += totalLoggedHours([e], now);
    byTech.set(key, cur);
  }
  const productivity = [...byTech.values()].sort((a, b) => b.hours - a.hours);

  // Active jobs by stage.
  const byStage = new Map<string, number>();
  for (const j of active) byStage.set(j.status, (byStage.get(j.status) ?? 0) + 1);

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={TrendingUp}
        eyebrow="Workshop intelligence"
        title="Workshop insights"
        description="Understand work-in-progress, profitability, technician productivity and warranty recovery across workshop operations."
        actions={<Link href="/jobcards" className="btn-secondary btn-sm"><ArrowLeft className="size-4" /> Workshop jobs</Link>}
        stats={[
          { label: "Work in progress", value: formatZAR(wipCents), detail: `${active.length} active job${active.length === 1 ? "" : "s"}`, icon: Gauge, tone: "primary" },
          { label: "Profit · 90 days", value: formatZAR(totals.profit), detail: `${marginPct}% margin on ${formatZAR(totals.revenue)}`, icon: BadgeDollarSign, tone: totals.profit >= 0 ? "success" : "danger" },
          { label: "Comeback rate · 90 days", value: `${comebackRate}%`, detail: `${totals.comebacks} of ${completed.length} completed`, icon: RotateCcw, tone: comebackRate > 10 ? "warning" : "default" },
          { label: "Warranty recovered", value: formatZAR(totals.warranty), detail: "Last 90 days", icon: ShieldCheck },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold mb-3">Technician productivity · 30 days</h2>
          {productivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No time logged in the last 30 days.</p>
          ) : (
            <div className="divide-y divide-border text-sm">
              {productivity.map((t) => (
                <div key={t.name} className="flex items-center justify-between py-1.5">
                  <span>{t.name}</span>
                  <span className="tabular-nums font-medium">{Math.round(t.hours * 10) / 10} h</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h2 className="font-semibold mb-3">Active jobs by stage</h2>
          {byStage.size === 0 ? (
            <p className="text-sm text-muted-foreground">No active jobs.</p>
          ) : (
            <div className="divide-y divide-border text-sm">
              {[...byStage.entries()]
                .filter(([s]) => !isTerminalStage(s))
                .map(([s, count]) => (
                  <div key={s} className="flex items-center justify-between py-1.5">
                    <span>{stageMeta(s).label}</span>
                    <span className="tabular-nums font-medium">{count}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
