import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarDays, Clock, Filter, Layers, Sparkles, Target, Trophy } from "lucide-react";
import { prisma } from "@/lib/db";
import { baseAndOthers, formatTotals } from "@/lib/currencyRules";
import { dashboardWindow, leadWhere, prevWonValue, wonThisMonthSplit } from "@/lib/dashboard/data";
import { formatDue, formatZAR, type MoneyFormat } from "@/lib/format";
import { loadTodayLeads } from "@/lib/leadScoreLoader";
import type { PermissionUser } from "@/lib/permissions";
import { rankedLeads, worklistColumns } from "@/lib/salesWorklist";
import { daysSince } from "@/lib/salesWorklistRules";
import { MetricCard } from "@/components/visual-system";
import OpenRecordLink from "@/components/records/OpenRecordLink";
import { CardEmpty, CardRow, Panel, StatRow } from "@/components/centre";

/**
 * The Sales Centre's numbers, side panel and cards (Sean's mockup, 2026-11-24).
 * Every figure is one the app already computes — Home's pipeline and won-this-month
 * (dashboard/data.ts), Today's ranking, the Attention Centre — over the leads this
 * person may see. Money is the base currency; other currencies are named beside it.
 */

export async function SalesCentreStats({ user, now, money }: { user: PermissionUser; now: Date; money: MoneyFormat }) {
  const [open, atRisk, won, prevWon, { period }] = await Promise.all([
    prisma.lead.findMany({ where: { ...(await leadWhere()), status: "open" }, select: { valueCents: true, currency: true } }),
    rankedLeads(user, "atrisk", now),
    wonThisMonthSplit(),
    prevWonValue(),
    dashboardWindow(),
  ]);
  const target = await prisma.target.findFirst({ where: { period, metric: "sales_value" }, select: { value: true } });
  const pipeline = baseAndOthers(open, (lead) => ({ cents: lead.valueCents, currency: lead.currency }), money.currency);
  const wonCents = won.base.reduce((sum, row) => sum + row.valueCents, 0);
  const elsewhere = (others: { currency: string; cents: number }[]) => (others.length ? ` + ${formatTotals(others, money, true)}` : "");
  return (
    <StatRow>
      <MetricCard icon={Target} label="Open opportunities" value={open.length} detail="Open deals you can see" accent />
      <MetricCard icon={AlertTriangle} label="Need attention" value={atRisk?.length ?? 0} detail="The Attention Centre says act" />
      <MetricCard icon={Layers} label="Pipeline value" value={formatZAR(pipeline.baseCents, money)} detail={`Open deals${elsewhere(pipeline.others)}`} />
      <MetricCard
        icon={Trophy}
        label="Won this month"
        value={formatZAR(wonCents, money) + elsewhere(won.others)}
        detail={
          target?.value
            ? `${Math.round((wonCents / target.value) * 100)}% of the ${formatZAR(target.value, money)} target`
            : `${formatZAR(prevWon, money)} by this day last month`
        }
      />
    </StatRow>
  );
}

/** Today's ranking, mine, best three — each with its reason and a way in. */
export async function NextBestActions({ user, now }: { user: PermissionUser; now: Date }) {
  const { leads } = await loadTodayLeads(user, { mine: true }, now);
  const top = leads.filter((lead) => lead.score > 0).slice(0, 3);
  return (
    <Panel icon={Sparkles} title="Next best actions" description="Your deals most worth a move today, and why." action={<Link href="/today" className="text-primary hover:underline">Today</Link>}>
      {top.length === 0 ? (
        <CardEmpty>None of your deals has a reason to contact them today.</CardEmpty>
      ) : (
        <ul className="space-y-3">
          {top.map((lead) => (
            <li key={lead.id} className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">{lead.name}</p>
              {lead.opportunity && <p className="text-xs text-muted-foreground">{lead.opportunity}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{lead.reasons.join(" · ")}</p>
              {/* Beside the list, where the reason's action can be taken (W2-03). */}
              <OpenRecordLink record={{ type: "lead", id: lead.id }} className="btn-secondary btn-sm mt-2">Open deal<ArrowRight className="size-3.5" /></OpenRecordLink>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const STALE_DAYS = 7;

export async function SalesCentreCards({ user, now, money }: { user: PermissionUser; now: Date; money: MoneyFormat }) {
  const openWhere = { ...(await leadWhere()), status: "open" };
  const [open, upcoming, quiet] = await Promise.all([
    prisma.lead.findMany({ where: openWhere, select: { valueCents: true, currency: true, stage: { select: { id: true, name: true, order: true, color: true } } } }),
    prisma.activity.findMany({
      where: { assignedToId: user.id, status: "planned", availabilityBlock: false, dueDate: { gte: now, lt: new Date(now.getTime() + STALE_DAYS * 86_400_000) } },
      select: { id: true, summary: true, dueDate: true, leadId: true },
      orderBy: { dueDate: "asc" },
      take: 4,
    }),
    // Candidates for "stale": the open deals untouched longest. The last-activity read below decides.
    prisma.lead.findMany({ where: openWhere, select: { id: true, name: true, valueCents: true, currency: true, createdAt: true }, orderBy: { updatedAt: "asc" }, take: 40 }),
  ]);

  const byStage = new Map<string, { name: string; order: number; color: string; count: number; cents: number }>();
  for (const lead of open) {
    const row = byStage.get(lead.stage.id) ?? { name: lead.stage.name, order: lead.stage.order, color: lead.stage.color, count: 0, cents: 0 };
    row.count += 1;
    // The bar's value is the base currency only; a stage's other-currency deals are counted, not added.
    if (!lead.currency || lead.currency === money.currency) row.cents += lead.valueCents;
    byStage.set(lead.stage.id, row);
  }
  const stages = [...byStage.values()].sort((a, b) => a.order - b.order);
  const widest = Math.max(1, ...stages.map((s) => s.count));

  const { last } = await worklistColumns(quiet.map((lead) => lead.id));
  const stale = quiet
    .map((lead) => ({ ...lead, since: last.get(lead.id) ?? lead.createdAt }))
    .filter((lead) => daysSince(lead.since, now) >= STALE_DAYS)
    .sort((a, b) => a.since.getTime() - b.since.getTime())
    .slice(0, 3);

  return (
    <>
      <Panel icon={Filter} title="Pipeline by stage" description="Open deals in each stage.">
        {stages.length === 0 ? (
          <CardEmpty>No open deals.</CardEmpty>
        ) : (
          <ul className="space-y-2">
            {stages.map((stage) => (
              <li key={stage.name} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{stage.name}</span>
                  <span className="tabular-nums text-muted-foreground">{stage.count} · {formatZAR(stage.cents, money)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-muted">
                  <div className="h-2 rounded-full" style={{ width: `${(stage.count / widest) * 100}%`, backgroundColor: stage.color }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel icon={CalendarDays} title="Upcoming activities" description="Your next planned steps, soonest first." action={<Link href="/calendar" className="text-primary hover:underline">View calendar</Link>}>
        {upcoming.length === 0 ? (
          <CardEmpty>Nothing planned for the next week.</CardEmpty>
        ) : (
          upcoming.map((activity) => (
            <CardRow key={activity.id} href={activity.leadId ? `/leads/${activity.leadId}` : "/activities"} title={activity.summary} aside={<span className="tabular-nums text-muted-foreground">{formatDue(activity.dueDate)}</span>} />
          ))
        )}
      </Panel>
      <Panel icon={Clock} title="Stale opportunities" description={`Open deals with no contact or completed task in ${STALE_DAYS}+ days.`} action={<Link href="/leads/list?show=atrisk" className="text-primary hover:underline">At risk</Link>}>
        {stale.length === 0 ? (
          <CardEmpty>Every open deal has been worked on this week.</CardEmpty>
        ) : (
          stale.map((lead) => (
            <CardRow
              key={lead.id}
              href={`/leads/${lead.id}`}
              title={lead.name}
              detail={lead.valueCents > 0 ? formatZAR(lead.valueCents, { ...money, currency: lead.currency ?? money.currency }) : undefined}
              aside={<span className="rounded-md bg-red-500/10 px-2 py-0.5 text-red-600 dark:text-red-400">{daysSince(lead.since, now)} days</span>}
            />
          ))
        )}
      </Panel>
    </>
  );
}
