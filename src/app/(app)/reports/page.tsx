import {
  addDays,
  differenceInCalendarDays,
  format,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import { TrendingDown, TrendingUp } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { formatZARCompact } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import ReportFilters from "@/components/reports/ReportFilters";
import {
  ChartCard,
  TrendChart,
  FunnelChart,
  SourcesChart,
  TeamChart,
  ServiceChart,
  type TrendPoint,
  type FunnelRow,
  type SourceRow,
  type TeamRow,
  type ServicePoint,
} from "@/components/reports/ReportCharts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* ── date range from the URL ──────────────────────────────────────── */

function resolveRange(params: Record<string, string | undefined>) {
  const now = new Date();
  const range = params.range ?? "mtd";
  let from: Date;
  let to = now;
  switch (range) {
    case "30d": from = subDays(now, 30); break;
    case "qtr": from = startOfQuarter(now); break;
    case "ytd": from = startOfYear(now); break;
    case "12m": from = subMonths(now, 12); break;
    case "custom": {
      const f = params.from ? new Date(params.from) : startOfMonth(now);
      const t = params.to ? addDays(new Date(params.to), 1) : now;
      from = isNaN(f.getTime()) ? startOfMonth(now) : f;
      to = isNaN(t.getTime()) ? now : t;
      break;
    }
    default: from = startOfMonth(now);
  }
  const lengthMs = Math.max(86400000, to.getTime() - from.getTime());
  const prevFrom = new Date(from.getTime() - lengthMs);
  return { from, to, prevFrom, prevTo: from };
}

/* ── time buckets for trend charts ────────────────────────────────── */

type Bucket = { start: Date; end: Date; label: string };

function makeBuckets(from: Date, to: Date): Bucket[] {
  const days = Math.max(1, differenceInCalendarDays(to, from));
  const stepDays = days <= 31 ? 1 : days <= 126 ? 7 : 30.44;
  const fmt = days <= 126 ? "d MMM" : "MMM yy";
  const buckets: Bucket[] = [];
  let cursor = from;
  while (cursor < to) {
    const end = new Date(Math.min(cursor.getTime() + stepDays * 86400000, to.getTime()));
    buckets.push({ start: cursor, end, label: format(cursor, fmt) });
    cursor = end;
  }
  return buckets;
}

const countIn = (buckets: Bucket[], dates: Date[]) =>
  buckets.map((b) => dates.filter((d) => d >= b.start && d < b.end).length);

/* ── source palette ───────────────────────────────────────────────── */

const SOURCE_COLORS: Record<string, string> = {
  facebook: "var(--chart-2)",
  instagram: "var(--chart-4)",
  website: "var(--chart-1)",
  whatsapp: "var(--chart-3)",
  referral: "var(--chart-5)",
  manual: "oklch(0.55 0.01 264)",
};

/* ── stat card with delta ─────────────────────────────────────────── */

function StatCard({
  label,
  value,
  delta,
  compare,
}: {
  label: string;
  value: string;
  delta: number | null;
  compare: string;
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="truncate text-2xl font-semibold tabular-nums text-foreground">{value}</p>
        {delta !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "flex shrink-0 cursor-default items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
                  up ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                )}
              >
                {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                {Math.abs(delta)}%
              </span>
            </TooltipTrigger>
            <TooltipContent>vs previous period ({compare})</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

const pct = (cur: number, prev: number): number | null =>
  prev === 0 ? (cur > 0 ? 100 : null) : Math.round(((cur - prev) / prev) * 100);

/* ── page ─────────────────────────────────────────────────────────── */

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const { from, to, prevFrom, prevTo } = resolveRange(params);

  // Lead-level filters shared by every lead query
  const leadFilter = {
    ...(params.user ? { assignedToId: params.user } : {}),
    ...(params.product ? { productId: params.product } : {}),
    ...(params.source ? { source: params.source } : {}),
  };

  const [
    leadsInRange,
    prevLeads,
    wonInRange,
    prevWon,
    lostInRange,
    prevLost,
    openLeads,
    jobsInRange,
    users,
    products,
    allSources,
  ] = await Promise.all([
    prisma.lead.findMany({
      where: { ...leadFilter, createdAt: { gte: from, lt: to } },
      select: { createdAt: true, source: true, status: true },
    }),
    prisma.lead.findMany({
      where: { ...leadFilter, createdAt: { gte: prevFrom, lt: prevTo } },
      select: { createdAt: true },
    }),
    // Won date isn't stored separately; updatedAt is when the deal was marked won.
    prisma.lead.findMany({
      where: { ...leadFilter, status: "won", updatedAt: { gte: from, lt: to } },
      select: {
        updatedAt: true,
        valueCents: true,
        source: true,
        assignedTo: { select: { name: true } },
      },
    }),
    prisma.lead.findMany({
      where: { ...leadFilter, status: "won", updatedAt: { gte: prevFrom, lt: prevTo } },
      select: { valueCents: true },
    }),
    prisma.lead.count({
      where: { ...leadFilter, status: "lost", updatedAt: { gte: from, lt: to } },
    }),
    prisma.lead.count({
      where: { ...leadFilter, status: "lost", updatedAt: { gte: prevFrom, lt: prevTo } },
    }),
    prisma.lead.findMany({
      where: { ...leadFilter, status: "open" },
      select: {
        valueCents: true,
        stage: { select: { id: true, name: true, color: true, order: true } },
      },
    }),
    prisma.jobCard.findMany({
      where: { status: "completed", completedAt: { gte: from, lt: to } },
      select: { completedAt: true },
    }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.product.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.lead.groupBy({ by: ["source"] }),
  ]);

  /* Trend */
  const buckets = makeBuckets(from, to);
  const prevBuckets = makeBuckets(prevFrom, prevTo);
  const leadCounts = countIn(buckets, leadsInRange.map((l) => l.createdAt));
  const prevCounts = countIn(prevBuckets, prevLeads.map((l) => l.createdAt));
  const trend: TrendPoint[] = buckets.map((b, i) => {
    const wonHere = wonInRange.filter((w) => w.updatedAt >= b.start && w.updatedAt < b.end);
    return {
      label: b.label,
      leads: leadCounts[i],
      won: wonHere.length,
      wonValue: Math.round(wonHere.reduce((s, w) => s + w.valueCents, 0) / 100),
      prevLeads: prevCounts[i] ?? null,
    };
  });

  /* Funnel (current pipeline, date-independent) */
  const stageMap = new Map<string, FunnelRow & { order: number }>();
  for (const l of openLeads) {
    const cur =
      stageMap.get(l.stage.id) ??
      { name: l.stage.name, count: 0, value: 0, color: l.stage.color, order: l.stage.order };
    cur.count += 1;
    cur.value += Math.round(l.valueCents / 100);
    stageMap.set(l.stage.id, cur);
  }
  const funnel = [...stageMap.values()].sort((a, b) => a.order - b.order);

  /* Sources */
  const srcMap = new Map<string, SourceRow>();
  for (const l of leadsInRange) {
    const cur =
      srcMap.get(l.source) ??
      { name: l.source, leads: 0, won: 0, color: SOURCE_COLORS[l.source] ?? "var(--chart-5)" };
    cur.leads += 1;
    if (l.status === "won") cur.won += 1;
    srcMap.set(l.source, cur);
  }
  const sources = [...srcMap.values()].sort((a, b) => b.leads - a.leads);

  /* Team */
  const teamMap = new Map<string, TeamRow>();
  for (const w of wonInRange) {
    const name = w.assignedTo?.name ?? "Unassigned";
    const cur = teamMap.get(name) ?? { name, won: 0, wonValue: 0 };
    cur.won += 1;
    cur.wonValue += Math.round(w.valueCents / 100);
    teamMap.set(name, cur);
  }
  const team = [...teamMap.values()].sort((a, b) => b.wonValue - a.wonValue);

  /* Service */
  const service: ServicePoint[] = buckets.map((b) => ({
    label: b.label,
    services: jobsInRange.filter((j) => j.completedAt! >= b.start && j.completedAt! < b.end).length,
  }));

  /* Stats + deltas */
  const wonValue = wonInRange.reduce((s, w) => s + w.valueCents, 0);
  const prevWonValue = prevWon.reduce((s, w) => s + w.valueCents, 0);
  const closed = wonInRange.length + lostInRange;
  const prevClosed = prevWon.length + prevLost;
  const winRate = closed ? Math.round((wonInRange.length / closed) * 100) : 0;
  const prevWinRate = prevClosed ? Math.round((prevWon.length / prevClosed) * 100) : 0;
  const compare = `${format(prevFrom, "d MMM")} – ${format(prevTo, "d MMM")}`;
  const filtered = !!(params.user || params.product || params.source);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description={`${format(from, "d MMM yyyy")} – ${format(to, "d MMM yyyy")}`}
      />

      <ReportFilters
        options={{ users, products, sources: allSources.map((s) => s.source).sort() }}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="New leads"
          value={String(leadsInRange.length)}
          delta={pct(leadsInRange.length, prevLeads.length)}
          compare={compare}
        />
        <StatCard
          label="Deals won"
          value={String(wonInRange.length)}
          delta={pct(wonInRange.length, prevWon.length)}
          compare={compare}
        />
        <StatCard
          label="Won value"
          value={formatZARCompact(wonValue)}
          delta={pct(wonValue, prevWonValue)}
          compare={compare}
        />
        <StatCard
          label="Win rate"
          value={`${winRate}%`}
          delta={prevClosed || closed ? winRate - prevWinRate : null}
          compare={compare}
        />
      </div>

      <ChartCard
        title="Sales trend"
        subtitle="New leads (line) and won deal value (bars) — dashed line is the previous period"
      >
        <TrendChart data={trend} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard
          title="Pipeline right now"
          subtitle={
            filtered
              ? "Open leads by stage (filters applied — date range doesn't apply here)"
              : "Open leads by stage (date range doesn't apply here)"
          }
        >
          <FunnelChart data={funnel} />
        </ChartCard>
        <ChartCard title="Lead sources" subtitle="Share of leads in period, with win rate per channel">
          <SourcesChart data={sources} />
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Team performance" subtitle="Value of deals won in period, per team member">
          {team.length ? (
            <TeamChart data={team} />
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground/70">
              No deals won in this period.
            </p>
          )}
        </ChartCard>
        <ChartCard
          title="Workshop"
          subtitle="Job cards completed per period (team/product filters don't apply)"
        >
          <ServiceChart data={service} />
        </ChartCard>
      </div>
    </div>
  );
}
