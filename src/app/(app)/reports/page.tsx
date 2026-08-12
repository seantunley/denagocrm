import {
  addDays,
  format,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { actingScopeClass } from "@/lib/actingScope";
import { formatZARCompact } from "@/lib/format";
import { isModuleEnabled } from "@/lib/modules/enabled";
import {
  breakdownOf,
  readStatisticBuckets,
  seriesOf,
  statisticsReadyFor,
  statisticsTenantId,
  totalOf,
  type StatisticMetric,
} from "@/lib/statistics";
import {
  periodForRange,
  periodStarts,
  sastBucketLabel,
  type StatisticPeriod,
} from "@/lib/statisticsTime";
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
import {
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getUserTeamIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

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
      const candidateFrom = params.from ? new Date(params.from) : startOfMonth(now);
      const candidateTo = params.to ? addDays(new Date(params.to), 1) : now;
      from = isNaN(candidateFrom.getTime()) ? startOfMonth(now) : candidateFrom;
      to = isNaN(candidateTo.getTime()) ? now : candidateTo;
      break;
    }
    default: from = startOfMonth(now);
  }
  const lengthMs = Math.max(86400000, to.getTime() - from.getTime());
  const prevFrom = new Date(from.getTime() - lengthMs);
  return { from, to, prevFrom, prevTo: from };
}

/**
 * Bucket spans for the LIVE (permission-restricted) path, built from the same
 * SAST-aligned axis the pre-aggregated path reads, so both produce the same
 * boundaries and the same labels.
 *
 * This replaces `makeBuckets`, which stepped by a literal 30.44 days for ranges
 * over four months. Those bars were not months — they drifted a little further
 * out of calendar alignment at every step — and their labels came from a bare
 * date-fns `format()`, which renders in the SERVER's zone rather than the
 * business's, so a bar could be named after the wrong day entirely.
 */
type Span = { start: Date; end: Date; label: string };

function spansFor(period: StatisticPeriod, axis: Date[], to: Date): Span[] {
  return axis.map((start, index) => ({
    start,
    end: axis[index + 1] ?? to,
    label: sastBucketLabel(period, start),
  }));
}

const countIn = (spans: Span[], dates: Date[]) =>
  spans.map((span) => dates.filter((date) => date >= span.start && date < span.end).length);

const SOURCE_COLORS: Record<string, string> = {
  facebook: "var(--chart-2)",
  instagram: "var(--chart-4)",
  website: "var(--chart-1)",
  whatsapp: "var(--chart-3)",
  referral: "var(--chart-5)",
  manual: "oklch(0.55 0.01 264)",
};

const sourceColor = (name: string) => SOURCE_COLORS[name] ?? "var(--chart-5)";

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

const pct = (current: number, previous: number): number | null =>
  previous === 0 ? (current > 0 ? 100 : null) : Math.round(((current - previous) / previous) * 100);

async function accessibleReportUserIds(userId: string, unrestricted: boolean): Promise<string[] | null> {
  if (unrestricted) return null;
  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return [userId];
  // getUserTeamIds is already tenant-scoped, but a TeamMember row could still
  // disagree with its own Team about tenancy — belt and suspenders, same as the
  // lock/read/write style used elsewhere for a bypass-client raw query.
  const scope = await actingScopeClass();
  // Just this reader, for anything that is not a resolved workspace. `global`
  // is a signed-in session that could not be resolved to one — stale, or
  // ambiguous across two active memberships — and it used to fall through to
  // `Prisma.empty`, so the people-filter listed teammates from every workspace.
  // `[userId]` is the same answer this already gives a person with no teams.
  if (scope.mode !== "tenant") return [userId];
  const tenantFilter = Prisma.sql`AND tm."tenantId" = ${scope.tenantId}`;
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT u."id"
    FROM "User" u
    WHERE u."id" = ${userId}
       OR u."id" IN (
         SELECT tm."userId" FROM "TeamMember" tm WHERE tm."teamId" = ANY(${teamIds}::text[]) ${tenantFilter}
       )
  `;
  return rows.map((row) => row.id);
}

/** Everything the charts need, however it was obtained. */
type Aggregates = {
  leads: number;
  prevLeads: number;
  won: number;
  prevWon: number;
  wonValueCents: number;
  prevWonValueCents: number;
  lost: number;
  prevLost: number;
  trend: TrendPoint[];
  team: TeamRow[];
  service: ServicePoint[];
  sources: SourceRow[];
};

/**
 * THE FAST PATH — every time series read from pre-aggregated buckets.
 *
 * What this replaces, on the twelve-month range: five window scans that
 * materialised rows into Node (a year of leads, a year of leads for the
 * comparison window, a year of won leads WITH a join to User, a year of won
 * leads for the comparison window, and a year of completed job cards), then
 * bucketed them with a nested filter loop that is buckets × rows. Cost grew
 * with the tenant's whole history and was paid again on every page view.
 *
 * What it costs instead: six reads of at most one row per bucket per dimension
 * — twelve months of buckets, not a year of leads.
 *
 * The one query that stays is the source breakdown, and it stays for a reason
 * worth stating rather than working around. "Of the leads created in this
 * window, how many are NOW won" is a COHORT measure: its answer for a window in
 * the past keeps changing as those leads close. A bucket sealed at the end of
 * its window cannot express that, and a bucket that could would have to be
 * recomputed over all history forever — which is the scan this feature exists
 * to remove. It is at least computed DB-side now, as a grouped count, rather
 * than by shipping every row to Node to be counted there.
 */
async function bucketAggregates(options: {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  period: StatisticPeriod;
  axis: Date[];
  prevAxis: Date[];
  automotiveOn: boolean;
  userNames: Map<string, string>;
  /** Resolved ONCE by the caller and threaded through every read below. */
  tenantId: string;
}): Promise<Aggregates> {
  const { from, to, prevFrom, prevTo, period, axis, prevAxis, automotiveOn, userNames, tenantId } =
    options;
  const read = (metric: StatisticMetric, rangeFrom: Date, rangeTo: Date) =>
    readStatisticBuckets({ metric, period, from: rangeFrom, to: rangeTo, tenantId });

  const [leadRows, prevLeadRows, wonRows, prevWonRows, lostRows, prevLostRows, jobRows, sourceRows] =
    await Promise.all([
      read("leads_created", from, to),
      read("leads_created", prevFrom, prevTo),
      read("deals_won", from, to),
      read("deals_won", prevFrom, prevTo),
      read("deals_lost", from, to),
      read("deals_lost", prevFrom, prevTo),
      automotiveOn ? read("jobcards_completed", from, to) : Promise.resolve([]),
      prisma.lead.groupBy({
        by: ["source", "status"],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
    ]);

  const leadSeries = seriesOf(leadRows, axis);
  const prevLeadSeries = seriesOf(prevLeadRows, prevAxis);
  const wonSeries = seriesOf(wonRows, axis);
  const jobSeries = seriesOf(jobRows, axis);

  const sourceMap = new Map<string, SourceRow>();
  for (const row of sourceRows) {
    const current =
      sourceMap.get(row.source) ??
      { name: row.source, leads: 0, won: 0, color: sourceColor(row.source) };
    current.leads += row._count._all;
    if (row.status === "won") current.won += row._count._all;
    sourceMap.set(row.source, current);
  }

  return {
    leads: totalOf(leadRows).count,
    prevLeads: totalOf(prevLeadRows).count,
    won: totalOf(wonRows).count,
    prevWon: totalOf(prevWonRows).count,
    wonValueCents: totalOf(wonRows).sumCents,
    prevWonValueCents: totalOf(prevWonRows).sumCents,
    lost: totalOf(lostRows).count,
    prevLost: totalOf(prevLostRows).count,
    trend: axis.map((start, index) => ({
      label: sastBucketLabel(period, start),
      leads: leadSeries[index].count,
      won: wonSeries[index].count,
      wonValue: Math.round(wonSeries[index].sumCents / 100),
      prevLeads: prevLeadSeries[index]?.count ?? null,
    })),
    // The deals_won breakdown IS the team chart — the dimension is the assignee.
    team: [...breakdownOf(wonRows)]
      .map(([assigneeId, value]) => ({
        name: assigneeId === "" ? "Unassigned" : userNames.get(assigneeId) ?? "Unknown",
        won: value.count,
        wonValue: Math.round(value.sumCents / 100),
      }))
      .sort((a, b) => b.wonValue - a.wonValue),
    service: axis.map((start, index) => ({
      label: sastBucketLabel(period, start),
      services: jobSeries[index].count,
    })),
    sources: [...sourceMap.values()].sort((a, b) => b.leads - a.leads),
  };
}

/**
 * THE LIVE PATH — unchanged in what it computes, used when buckets cannot
 * answer the question.
 *
 * Two cases reach it, and both are correctness, not preference:
 *
 *  - THE READER IS RESTRICTED, or has filtered by user / product / source.
 *    Buckets are aggregates over a whole tenant; they cannot be re-filtered by
 *    an arbitrary list of permitted record ids after the fact. Serving a
 *    restricted reader from them would show them other people's numbers, which
 *    is a worse failure than a slow page.
 *  - THE BUCKETS ARE NOT BUILT YET. Between a deploy and the first cron tick
 *    the table is empty, and a chart that reads an unbuilt table draws a flat
 *    zero line — which looks like the business collapsed rather than like a
 *    cold start.
 */
async function liveAggregates(options: {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  spans: Span[];
  prevSpans: Span[];
  leadFilter: Record<string, unknown>;
  jobScope: Record<string, unknown>;
  automotiveOn: boolean;
}): Promise<Aggregates> {
  const { from, to, prevFrom, prevTo, spans, prevSpans, leadFilter, jobScope, automotiveOn } = options;

  const [leadsInRange, prevLeads, wonInRange, prevWon, lostInRange, prevLost, jobsInRange] =
    await Promise.all([
      prisma.lead.findMany({
        where: { ...leadFilter, createdAt: { gte: from, lt: to } },
        select: { createdAt: true, source: true, status: true },
      }),
      prisma.lead.findMany({
        where: { ...leadFilter, createdAt: { gte: prevFrom, lt: prevTo } },
        select: { createdAt: true },
      }),
      // `wonAt` / `lostAt`, NOT `updatedAt` — the same immutable lifecycle dates
      // the buckets are keyed on. This path serves the restricted and filtered
      // readers, so if it dated a won deal differently the two paths would
      // report different numbers for the same month to different people, and
      // adding a note to an old deal would move it into the current month here
      // while the bucket path kept it where it closed.
      prisma.lead.findMany({
        where: { ...leadFilter, status: "won", wonAt: { gte: from, lt: to } },
        select: {
          wonAt: true,
          valueCents: true,
          assignedTo: { select: { name: true } },
        },
      }),
      prisma.lead.findMany({
        where: { ...leadFilter, status: "won", wonAt: { gte: prevFrom, lt: prevTo } },
        select: { valueCents: true },
      }),
      prisma.lead.count({
        where: { ...leadFilter, status: "lost", lostAt: { gte: from, lt: to } },
      }),
      prisma.lead.count({
        where: { ...leadFilter, status: "lost", lostAt: { gte: prevFrom, lt: prevTo } },
      }),
      automotiveOn
        ? prisma.jobCard.findMany({
            where: { ...jobScope, completedAt: { gte: from, lt: to } },
            select: { completedAt: true },
          })
        : Promise.resolve([]),
    ]);

  const leadCounts = countIn(spans, leadsInRange.map((lead) => lead.createdAt));
  const prevCounts = countIn(prevSpans, prevLeads.map((lead) => lead.createdAt));

  const sourceMap = new Map<string, SourceRow>();
  for (const lead of leadsInRange) {
    const current =
      sourceMap.get(lead.source) ??
      { name: lead.source, leads: 0, won: 0, color: sourceColor(lead.source) };
    current.leads += 1;
    if (lead.status === "won") current.won += 1;
    sourceMap.set(lead.source, current);
  }

  const teamMap = new Map<string, TeamRow>();
  for (const won of wonInRange) {
    const name = won.assignedTo?.name ?? "Unassigned";
    const current = teamMap.get(name) ?? { name, won: 0, wonValue: 0 };
    current.won += 1;
    current.wonValue += Math.round(won.valueCents / 100);
    teamMap.set(name, current);
  }

  return {
    leads: leadsInRange.length,
    prevLeads: prevLeads.length,
    won: wonInRange.length,
    prevWon: prevWon.length,
    wonValueCents: wonInRange.reduce((sum, won) => sum + won.valueCents, 0),
    prevWonValueCents: prevWon.reduce((sum, won) => sum + won.valueCents, 0),
    lost: lostInRange,
    prevLost,
    trend: spans.map((span, index) => {
      const wonHere = wonInRange.filter((won) => won.wonAt! >= span.start && won.wonAt! < span.end);
      return {
        label: span.label,
        leads: leadCounts[index],
        won: wonHere.length,
        wonValue: Math.round(wonHere.reduce((sum, won) => sum + won.valueCents, 0) / 100),
        prevLeads: prevCounts[index] ?? null,
      };
    }),
    team: [...teamMap.values()].sort((a, b) => b.wonValue - a.wonValue),
    service: spans.map((span) => ({
      label: span.label,
      services: jobsInRange.filter(
        (job) => job.completedAt! >= span.start && job.completedAt! < span.end,
      ).length,
    })),
    sources: [...sourceMap.values()].sort((a, b) => b.leads - a.leads),
  };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireAnyPermission("reports.view_all", "reports.view_team", "reports.view");
  const automotiveOn = await isModuleEnabled("automotive");
  const params = await searchParams;
  const { from, to, prevFrom, prevTo } = resolveRange(params);
  const unrestricted = await hasPermission(user, "reports.view_all");
  const [leadIds, jobCardIds, reportUserIds, staff] = await Promise.all([
    getAccessibleLeadIds(user),
    getAccessibleJobCardIds(user),
    accessibleReportUserIds(user.id, unrestricted),
    // The "filter by team member" dropdown. This used to be
    // `prisma.user.findMany({ where: reportUserIds === null ? {} : … })`, and the
    // `{}` is the whole defect: `User` is a global model, so an unrestricted
    // reader — every owner — was offered every person on the platform by name.
    // RBAC narrowed it for RESTRICTED readers only, which is backwards: the more
    // privileged the reader, the wider the disclosure.
    //
    // The acting variant, not the background one, for the reason this whole sweep
    // exists: `listTenantStaff` skips its TenantMember join while enforcement is
    // dormant and would have reproduced the same global list.
    listActingTenantStaff(),
  ]);
  // Two independent narrowings, and the report needs BOTH: membership of this
  // workspace (who exists here at all) and RBAC (whose numbers this reader may
  // see). Applied in that order so an id that passes one still has to pass the
  // other.
  const users = (reportUserIds === null ? staff : staff.filter((u) => reportUserIds.includes(u.id)))
    .map((u) => ({ id: u.id, name: u.name }));
  // The FILTER is the action behind this screen — `?user=` is submitted, and a
  // submitted id must be judged by the same list the dropdown was built from
  // rather than by the looser RBAC set. Otherwise a hand-typed id from another
  // workspace still reaches `assignedToId`, and while that returns no rows today
  // (leads are tenant-scoped), it is an unvalidated identifier flowing into a
  // query on the strength of nobody having found a use for it yet.
  const requestedUser = params.user && users.some((u) => u.id === params.user)
    ? params.user
    : undefined;

  const leadScope = leadIds === null ? {} : { id: { in: leadIds } };
  const jobScope = jobCardIds === null ? {} : { id: { in: jobCardIds } };
  const leadFilter = {
    ...leadScope,
    ...(requestedUser ? { assignedToId: requestedUser } : {}),
    ...(params.product ? { productId: params.product } : {}),
    ...(params.source ? { source: params.source } : {}),
  };
  const filtered = Boolean(requestedUser || params.product || params.source);

  // ONE axis, shared by both paths — so switching between them can never move a
  // bar. Day buckets below four months, calendar months above, which is the
  // same threshold the page already used to switch its labels.
  const period = periodForRange(from, to);
  const axis = periodStarts(period, from, to);
  const prevAxis = periodStarts(period, prevFrom, prevTo);

  // The buckets are a whole-tenant aggregate with no per-record permissions in
  // them, so a restricted or filtered reader must not be served from them. See
  // liveAggregates.
  const neededMetrics: StatisticMetric[] = automotiveOn
    ? ["leads_created", "deals_won", "deals_lost", "jobcards_completed"]
    : ["leads_created", "deals_won", "deals_lost"];
  // ONE tenant resolution for the whole render, from the request scope — never
  // from a bucket row. The readiness check and every bucket read below are given
  // the SAME value, so the page cannot decide it is ready on one workspace's
  // cursor and then read another workspace's numbers.
  const statsTenantId = statisticsTenantId();
  const useBuckets =
    unrestricted && !filtered && (await statisticsReadyFor(neededMetrics, statsTenantId));

  const [openLeads, products, allSources] = await Promise.all([
    prisma.lead.findMany({
      where: { ...leadFilter, status: "open" },
      select: {
        valueCents: true,
        stage: { select: { id: true, name: true, color: true, order: true } },
      },
    }),
    prisma.product.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.lead.groupBy({ by: ["source"], where: leadScope }),
  ]);

  const aggregates = useBuckets
    ? await bucketAggregates({
        from,
        to,
        prevFrom,
        prevTo,
        period,
        axis,
        prevAxis,
        automotiveOn,
        userNames: new Map(users.map((u) => [u.id, u.name ?? "Unnamed"])),
        tenantId: statsTenantId,
      })
    : await liveAggregates({
        from,
        to,
        prevFrom,
        prevTo,
        spans: spansFor(period, axis, to),
        prevSpans: spansFor(period, prevAxis, prevTo),
        leadFilter,
        jobScope,
        automotiveOn,
      });

  const stageMap = new Map<string, FunnelRow & { order: number }>();
  for (const lead of openLeads) {
    const current = stageMap.get(lead.stage.id) ?? {
      name: lead.stage.name,
      count: 0,
      value: 0,
      color: lead.stage.color,
      order: lead.stage.order,
    };
    current.count += 1;
    current.value += Math.round(lead.valueCents / 100);
    stageMap.set(lead.stage.id, current);
  }
  const funnel = [...stageMap.values()].sort((a, b) => a.order - b.order);

  const closed = aggregates.won + aggregates.lost;
  const prevClosed = aggregates.prevWon + aggregates.prevLost;
  const winRate = closed ? Math.round((aggregates.won / closed) * 100) : 0;
  const prevWinRate = prevClosed ? Math.round((aggregates.prevWon / prevClosed) * 100) : 0;
  const compare = `${format(prevFrom, "d MMM")} – ${format(prevTo, "d MMM")}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description={`${format(from, "d MMM yyyy")} – ${format(to, "d MMM yyyy")}${unrestricted ? "" : " · restricted to your permitted records"}`}
      />

      <ReportFilters options={{ users, products, sources: allSources.map((source) => source.source).sort() }} />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="New leads" value={String(aggregates.leads)} delta={pct(aggregates.leads, aggregates.prevLeads)} compare={compare} />
        <StatCard label="Deals won" value={String(aggregates.won)} delta={pct(aggregates.won, aggregates.prevWon)} compare={compare} />
        <StatCard label="Won value" value={formatZARCompact(aggregates.wonValueCents)} delta={pct(aggregates.wonValueCents, aggregates.prevWonValueCents)} compare={compare} />
        <StatCard label="Win rate" value={`${winRate}%`} delta={prevClosed || closed ? winRate - prevWinRate : null} compare={compare} />
      </div>

      <ChartCard title="Sales trend" subtitle="New leads (line) and won deal value (bars) — dashed line is the previous period">
        <TrendChart data={aggregates.trend} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Pipeline right now" subtitle={filtered ? "Open leads by stage (filters applied — date range doesn't apply here)" : "Open leads by stage (date range doesn't apply here)"}>
          <FunnelChart data={funnel} />
        </ChartCard>
        <ChartCard title="Lead sources" subtitle="Share of leads in period, with win rate per channel">
          <SourcesChart data={aggregates.sources} />
        </ChartCard>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${automotiveOn ? "xl:grid-cols-2" : ""}`}>
        <ChartCard title="Team performance" subtitle="Value of accessible deals won in period, per team member">
          {aggregates.team.length ? <TeamChart data={aggregates.team} /> : <p className="py-8 text-center text-xs text-muted-foreground/70">No deals won in this period.</p>}
        </ChartCard>
        {automotiveOn && (
          <ChartCard title="Workshop" subtitle="Accessible job cards completed per period">
            <ServiceChart data={aggregates.service} />
          </ChartCard>
        )}
      </div>
    </div>
  );
}
