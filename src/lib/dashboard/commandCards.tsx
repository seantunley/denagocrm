import "server-only";
import { cache } from "react";
import Link from "next/link";
import { addMonths, differenceInCalendarDays, subDays } from "date-fns";
import { CircleDollarSign, Target, SquareKanban, Truck, TriangleAlert, ArrowRight } from "lucide-react";
import { prisma } from "@/lib/db";
import { getAccessibleCaseIds } from "@/lib/permissions";
import { getRegionalSettings } from "@/lib/settings";
import { formatDateTime, formatZAR, currencySymbol } from "@/lib/format";
import { formatTotals, totalsByCurrency, withCurrency } from "@/lib/currencyRules";
import { quotePricing } from "@/lib/pricing";
import { loadAttentionList } from "@/lib/attention/load";
import { listForecastLeads, summarizeForecast } from "@/lib/pipelines";
import { Stagger, StaggerItem, StatSparkCard, type SparkStat } from "@/components/dashboard/widgets";
import { SectionCard } from "@/components/dashboard/sections";
import type { DashboardCardId } from "./registry";
import type { DashboardCardImpl } from "./cards";
import {
  dashboardViewer,
  dashboardWindow,
  grants,
  leadWhere,
  quoteWhere,
  jobCardWhere,
  leadScope,
  wonThisMonthSplit,
  prevWonValue,
  dailySeries,
  pctDelta,
} from "./data";
import {
  TREND_MONTHS,
  WINDOW_DAYS,
  deliveredOnTime,
  exceptionGroups,
  lastMonths,
  lostWithin,
  winRatePct,
  wonByMonth,
  wonOn,
  wonWithin,
} from "./commandCentre";

/**
 * The Command Centre cards (brief §8) — loaders and renderers for the
 * template-only cards declared in ./registry.ts. Definitions live in
 * ./commandCentre.ts and are documented in the help article
 * "dashboards-command-centre".
 *
 * The same two rules as ./cards.tsx, and they are the whole point:
 *   - ROW SCOPE: every lead/quote/job-card read spreads the viewer's scope from
 *     ./data.ts (leadWhere, quoteWhere, jobCardWhere); cases use the help desk's
 *     own accessible-id helper; the Attention list scopes itself. A card never
 *     counts a record its viewer could not open.
 *   - STRAND GATES: a card that mixes record types checks each strand against
 *     the viewer's permissions and modules, and drops what they may not see.
 *
 * Money is never added across currencies: a single figure is the base currency
 * and the rest is named beside it (currencyRules).
 */

type CommandCardId = Extract<DashboardCardId, `cc-${string}`>;

/**
 * Same shape as `card()` in ./cards.tsx. Repeated rather than imported: cards.tsx
 * imports THIS file, and calling its `card` at module load here would be a cycle.
 */
function card<T>(load: () => Promise<T>, render: (data: T) => React.ReactNode): DashboardCardImpl {
  return { load: async () => ({ node: render(await load()), signals: {} }) };
}

/** Help-desk cases the viewer may open, as a `where` — null from the helper means unrestricted. */
const caseWhere = cache(async () => {
  const ids = await getAccessibleCaseIds((await dashboardViewer()).user);
  return ids === null ? {} : { id: { in: ids } };
});

/** Activities: `activities.manage` runs everybody's diary, `activities.view` sees your own (compile.ts's rule). */
const activityWhere = cache(async () => {
  const { user, access } = await dashboardViewer();
  return grants(access, "activities.manage") ? {} : { assignedToId: user.id };
});

/** Every card says when its numbers were read: they are computed live, on each visit. */
function AsOf({ at, regional, note }: { at: Date; regional: Parameters<typeof formatDateTime>[1]; note?: string }) {
  return (
    <p className="mt-auto pt-2 text-[10px] text-muted-foreground/80">
      {note ? `${note} · ` : ""}Live from your records · as of {formatDateTime(at, regional)}
    </p>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-2 text-xs text-muted-foreground/70">{children}</p>
);

/** One "label … value" line that links to the list behind it. */
function MetricRow({ label, value, detail, href, warn }: { label: string; value: string; detail?: string; href: string; warn?: boolean }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-2 py-1.5 text-[13px] hover:text-primary">
        <span className="min-w-0 flex-1 truncate">
          {label}
          {detail && <span className="text-[11px] text-muted-foreground"> · {detail}</span>}
        </span>
        <span className={`shrink-0 font-semibold tabular-nums ${warn ? "text-amber-400" : "text-foreground"}`}>{value}</span>
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

const BAND_LABEL: Record<string, string> = { urgent: "Urgent", act: "Act", watch: "Watch", none: "—" };

export const COMMAND_CARD_IMPLS: Record<CommandCardId, DashboardCardImpl> = {
  /* Four headline tiles, each on its own record type and each with what it is measured against. */
  "cc-headlines": card(
    async () => {
      const { access } = await dashboardViewer();
      const { now, daysSoFar } = await dashboardWindow();
      const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
      const seesDeliveries = access.modules.has("automotive") && grants(access, "deliveries.view", "deliveries.manage");
      const window = { gte: subDays(now, WINDOW_DAYS), lt: now };
      const [moneyFmt, wonSplit, prevWon, won90, lost90, open, delivered] = await Promise.all([
        getRegionalSettings(),
        seesLeads ? wonThisMonthSplit() : null,
        seesLeads ? prevWonValue() : 0,
        seesLeads ? prisma.lead.count({ where: { ...(await leadWhere()), ...wonWithin(window) } }) : 0,
        seesLeads ? prisma.lead.count({ where: { ...(await leadWhere()), ...lostWithin(window) } }) : 0,
        seesLeads
          ? prisma.lead.findMany({ where: { ...(await leadWhere()), status: "open" }, select: { valueCents: true, currency: true } })
          : [],
        seesDeliveries
          ? prisma.quote.findMany({
              where: { ...(await quoteWhere()), supersededAt: null, deliveredAt: window },
              select: { deliveredAt: true, deliveryScheduledFor: true },
            })
          : [],
      ]);
      const mark = currencySymbol(moneyFmt);
      const stats: { stat: SparkStat; icon: React.ReactNode }[] = [];

      if (wonSplit) {
        const wonCents = wonSplit.base.reduce((sum, w) => sum + w.valueCents, 0);
        stats.push({
          icon: <CircleDollarSign />,
          stat: {
            label: "Won this month",
            value: Math.round(wonCents / 100),
            display: "zar",
            currencyMark: mark,
            delta: pctDelta(wonCents, prevWon),
            context: wonSplit.others.length ? `Plus ${formatTotals(wonSplit.others, moneyFmt, true)} in other currencies` : "Deals won since the 1st",
            href: "/reports",
            spark: dailySeries(wonSplit.base.map(wonOn), daysSoFar, (i) => Math.round(wonSplit.base[i].valueCents / 100)),
          },
        });
        const rate = winRatePct(won90, lost90);
        // No deal decided in the window: there is no rate, and 0% would say every deal was lost.
        if (rate !== null) {
          stats.push({
            icon: <Target />,
            stat: { label: `Win rate (${WINDOW_DAYS} days)`, value: rate, display: "pct", delta: null, context: `${won90} won of ${won90 + lost90} decided`, href: "/reports", spark: [] },
          });
        }
        const [base, ...others] = totalsByCurrency(open, (lead) => ({ cents: lead.valueCents, currency: lead.currency }), moneyFmt.currency);
        stats.push({
          icon: <SquareKanban />,
          stat: {
            label: "Open pipeline",
            value: Math.round(base.cents / 100),
            display: "zar",
            currencyMark: mark,
            delta: null,
            context: `${open.length} open deal${open.length === 1 ? "" : "s"}${others.length ? ` · plus ${formatTotals(others, moneyFmt, true)}` : ""}`,
            href: "/leads",
            spark: [],
          },
        });
      }
      const onTime = deliveredOnTime(delivered.flatMap((q) => (q.deliveredAt ? [{ deliveredAt: q.deliveredAt, deliveryScheduledFor: q.deliveryScheduledFor }] : [])));
      // Nothing delivered against a booked date: nothing to measure, so no tile.
      if (onTime.pct !== null) {
        stats.push({
          icon: <Truck />,
          stat: {
            label: `Delivered on time (${WINDOW_DAYS} days)`,
            value: onTime.pct,
            display: "pct",
            delta: null,
            context: `${onTime.onTime} of ${onTime.booked} with a booked date`,
            href: "/deliveries",
            spark: [],
            tone: onTime.pct < 100 ? "warn" : "default",
          },
        });
      }
      return stats;
    },
    (stats) =>
      stats.length === 0 ? null : (
        <Stagger className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {stats.map(({ stat, icon }) => (
            <StaggerItem key={stat.label}>
              <StatSparkCard stat={stat} icon={icon} />
            </StaggerItem>
          ))}
        </Stagger>
      ),
  ),

  /* Won value per calendar month — recorded wins only. */
  "cc-revenue-trend": card(
    async () => {
      const { now } = await dashboardWindow();
      const months = lastMonths(now, TREND_MONTHS);
      const [moneyFmt, rows] = await Promise.all([
        getRegionalSettings(),
        prisma.lead.findMany({
          where: { ...(await leadWhere()), ...wonWithin({ gte: months[0].start, lt: now }) },
          select: { wonAt: true, updatedAt: true, valueCents: true, currency: true },
        }),
      ]);
      const trend = wonByMonth(rows.map((r) => ({ at: wonOn(r), valueCents: r.valueCents, currency: r.currency })), months, moneyFmt.currency);
      return { ...trend, moneyFmt, now };
    },
    ({ bars, others, moneyFmt, now }) => {
      const peak = Math.max(1, ...bars.map((bar) => bar.baseCents));
      return (
        <SectionCard title="Won value by month" action={{ href: "/reports", label: "Reports" }}>
          <ul className="flex h-40 items-end gap-1" aria-label="Won value by month">
            {bars.map((bar, index) => (
              <li key={`${bar.label}-${index}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <div
                  className={`w-full rounded-t ${index === bars.length - 1 ? "bg-primary/50" : "bg-primary/80"}`}
                  // A measured value, not a design token — the chart.tsx convention.
                  style={{ height: `${Math.max(bar.baseCents > 0 ? 3 : 0, (bar.baseCents / peak) * 100)}%` }}
                  title={`${bar.label}: ${formatZAR(bar.baseCents, moneyFmt)} · ${bar.count} won`}
                />
                <span className="text-[10px] text-muted-foreground">{bar.label}</span>
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">Not in the bars: {formatTotals(others, moneyFmt)} in other currencies.</p>
          )}
          <AsOf at={now} regional={moneyFmt} note="Base currency · this month so far · no projection" />
        </SectionCard>
      );
    },
  ),

  /* Fulfilment, workshop and help desk — each strand only with its module and permission. */
  "cc-operations": card(
    async () => {
      const { access } = await dashboardViewer();
      const { now, todayStart } = await dashboardWindow();
      const moneyFmt = await getRegionalSettings();
      const automotive = access.modules.has("automotive");
      const seesDeliveries = automotive && grants(access, "deliveries.view", "deliveries.manage");
      const seesJobCards = automotive && grants(access, "jobcards.view_all", "jobcards.view_owned");
      const seesCases = access.modules.has("support") && grants(access, "cases.view_all", "cases.view_owned");

      const [accepted, openJobCards, openCases, unassignedCases] = await Promise.all([
        seesDeliveries
          ? prisma.quote.findMany({
              // Current revisions only: a superseded quote is not an order.
              where: { ...(await quoteWhere()), status: "accepted", supersededAt: null, deliveredAt: null },
              select: {
                currency: true,
                taxInclusive: true,
                depositType: true,
                depositValue: true,
                depositPaidAt: true,
                deliveryScheduledFor: true,
                items: true,
                fees: true,
              },
            })
          : null,
        // The "Open job cards" tile's own definition (cards.tsx service-stats).
        seesJobCards ? prisma.jobCard.count({ where: { ...(await jobCardWhere()), status: { not: "completed" } } }) : null,
        // The help desk's "Open" folder (lib/helpdesk.ts).
        seesCases ? prisma.customerCase.count({ where: { ...(await caseWhere()), status: { in: ["new", "open", "waiting_internal"] } } }) : null,
        seesCases
          ? prisma.customerCase.count({
              where: { ...(await caseWhere()), assignedToId: null, status: { notIn: ["resolved", "closed", "cancelled"] } },
            })
          : null,
      ]);

      const rows: { label: string; value: string; detail?: string; href: string; warn?: boolean }[] = [];
      if (accepted) {
        const priced = accepted.map((q) => ({
          ...q,
          pricing: quotePricing(q.items, q.fees, { taxInclusive: q.taxInclusive, depositType: q.depositType, depositValue: q.depositValue }),
        }));
        const value = totalsByCurrency(priced, (q) => ({ cents: q.pricing.totalCents, currency: q.currency }), moneyFmt.currency);
        const late = priced.filter((q) => q.deliveryScheduledFor && q.deliveryScheduledFor < todayStart).length;
        const noDeposit = priced.filter((q) => q.pricing.depositCents > 0 && !q.depositPaidAt).length;
        rows.push(
          { label: "Accepted, not yet delivered", value: String(priced.length), detail: formatTotals(value, moneyFmt, true), href: "/deliveries" },
          { label: "Delivery date passed", value: String(late), href: "/deliveries", warn: late > 0 },
          { label: "Deposit due, not recorded", value: String(noDeposit), href: "/invoices", warn: noDeposit > 0 },
        );
      }
      if (openJobCards !== null) rows.push({ label: "Open job cards", value: String(openJobCards), href: "/jobcards" });
      if (openCases !== null) rows.push({ label: "Open help-desk cases", value: String(openCases), href: "/cases?folder=open" });
      if (unassignedCases !== null) {
        rows.push({ label: "Cases nobody owns", value: String(unassignedCases), href: "/cases?folder=unassigned", warn: unassignedCases > 0 });
      }
      return { rows, now, moneyFmt };
    },
    ({ rows, now, moneyFmt }) =>
      rows.length === 0 ? null : (
        <SectionCard title="Operations status">
          <ul className="divide-y divide-border/50">
            {rows.map((row) => (
              <MetricRow key={row.label} {...row} />
            ))}
          </ul>
          <AsOf at={now} regional={moneyFmt} />
        </SectionCard>
      ),
  ),

  /* The Attention list, grouped by reason — the attention engine's rules, not new ones. */
  "cc-exceptions": card(
    async () => {
      const { user } = await dashboardViewer();
      const { now } = await dashboardWindow();
      const [list, moneyFmt] = await Promise.all([loadAttentionList(user, now), getRegionalSettings()]);
      return {
        groups: exceptionGroups(list.leads, moneyFmt.currency),
        deals: list.leads.length,
        setAside: list.snoozed.length + list.dismissed.length,
        now,
        moneyFmt,
      };
    },
    ({ groups, deals, setAside, now, moneyFmt }) => (
      <SectionCard title="Management by exception" action={{ href: "/leads/attention", label: "Attention list" }}>
        {groups.length === 0 ? (
          <Empty>No open deal needs attention.</Empty>
        ) : (
          <ul className="divide-y divide-border/50">
            {groups.map((group) => (
              <li key={group.kind} className="flex items-start gap-2.5 py-1.5">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-300">
                  <TriangleAlert className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {group.label}
                    <span className="text-[11px] font-normal text-muted-foreground"> · {formatTotals(group.totals, moneyFmt, true)}</span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    e.g.{" "}
                    <Link href={`/leads/${group.example.id}`} className="text-foreground hover:text-primary">
                      {group.example.name}
                    </Link>{" "}
                    — {group.example.detail}
                  </p>
                </div>
                <span className="badge shrink-0 bg-amber-500/10 text-amber-300">
                  {group.count} deal{group.count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <AsOf
          at={now}
          regional={moneyFmt}
          note={`${deals} deal${deals === 1 ? "" : "s"} on the list${setAside ? ` · ${setAside} set aside with a reason` : ""}`}
        />
      </SectionCard>
    ),
  ),

  /* Per person: open deals, deals needing attention, overdue follow-ups. Counts, not a capacity score. */
  "cc-team-workload": card(
    async () => {
      const { user, access } = await dashboardViewer();
      const { now, todayStart } = await dashboardWindow();
      const seesActivities = grants(access, "activities.view", "activities.manage");
      const [open, attention, overdue, moneyFmt] = await Promise.all([
        prisma.lead.groupBy({ by: ["assignedToId"], where: { ...(await leadWhere()), status: "open" }, _count: { _all: true } }),
        loadAttentionList(user, now),
        seesActivities
          ? prisma.activity.groupBy({
              by: ["assignedToId"],
              where: { ...(await activityWhere()), status: "planned", availabilityBlock: false, dueDate: { lt: todayStart } },
              _count: { _all: true },
            })
          : [],
        getRegionalSettings(),
      ]);
      const people = new Map<string, { open: number; attention: number; overdue: number }>();
      const row = (id: string | null) => {
        const key = id ?? "";
        const current = people.get(key) ?? { open: 0, attention: 0, overdue: 0 };
        people.set(key, current);
        return current;
      };
      for (const group of open) row(group.assignedToId).open = group._count._all;
      for (const lead of attention.leads) row(lead.ownerId).attention += 1;
      for (const group of overdue) row(group.assignedToId).overdue = group._count._all;
      // User is a global model, but these ids come only from the scoped rows above,
      // so this names people already shown as owners on records the viewer may open.
      const ids = [...people.keys()].filter(Boolean);
      const names = new Map(
        (ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]),
      );
      const rows = [...people.entries()]
        .map(([id, counts]) => ({ id, name: id ? (names.get(id) ?? "Former team member") : "Unassigned", ...counts }))
        .sort((a, b) => b.open - a.open || b.attention - a.attention)
        .slice(0, 8);
      return { rows, seesActivities, now, moneyFmt };
    },
    ({ rows, seesActivities, now, moneyFmt }) => (
      <SectionCard title="Team workload" action={{ href: "/leads/list", label: "Deals" }}>
        {rows.length === 0 ? (
          <Empty>No open deals.</Empty>
        ) : (
          <div className="text-[13px]">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 border-b border-border/50 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>Person</span>
              <span className="text-right">Open</span>
              <span className="text-right">Attention</span>
              <span className="text-right">{seesActivities ? "Overdue" : ""}</span>
            </div>
            {rows.map((person) => (
              <div key={person.id || "unassigned"} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 border-b border-border/30 py-1.5 last:border-0">
                <span className="truncate">{person.name}</span>
                <span className="text-right tabular-nums">{person.open}</span>
                <span className={`text-right tabular-nums ${person.attention > 0 ? "text-amber-400" : ""}`}>{person.attention}</span>
                <span className={`text-right tabular-nums ${person.overdue > 0 ? "text-red-400" : ""}`}>{seesActivities ? person.overdue : ""}</span>
              </div>
            ))}
          </div>
        )}
        <AsOf at={now} regional={moneyFmt} note="Overdue = planned follow-ups past their day" />
      </SectionCard>
    ),
  ),

  /* The top of the Attention list: biggest risk first, by the engine's own ranking. */
  "cc-top-risks": card(
    async () => {
      const { user } = await dashboardViewer();
      const { now } = await dashboardWindow();
      const [list, moneyFmt] = await Promise.all([loadAttentionList(user, now), getRegionalSettings()]);
      return { leads: list.leads.slice(0, 6), now, moneyFmt };
    },
    ({ leads, now, moneyFmt }) => (
      <SectionCard title="Deals most at risk" action={{ href: "/leads/attention", label: "Attention list" }}>
        {leads.length === 0 ? (
          <Empty>Nothing at risk right now.</Empty>
        ) : (
          <ul className="divide-y divide-border/50">
            {leads.map((lead) => (
              <li key={lead.id} className="flex items-center gap-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">
                    <Link href={`/leads/${lead.id}`} className="font-medium text-foreground hover:text-primary">
                      {lead.name}
                    </Link>
                    <span className="text-[11px] text-muted-foreground">
                      {" "}· {lead.stageName}
                      {lead.ownerName ? ` · ${lead.ownerName}` : ""}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">{lead.signals[0]?.detail}</p>
                </div>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums">
                  {formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency))}
                </span>
                <span className="badge shrink-0 bg-amber-500/10 text-amber-300">{BAND_LABEL[lead.band] ?? lead.band}</span>
              </li>
            ))}
          </ul>
        )}
        <AsOf at={now} regional={moneyFmt} note="Ranked by the Attention list" />
      </SectionCard>
    ),
  ),

  /* This month's sales target beside the forecast page's own figures. */
  "cc-forecast": card(
    async () => {
      const { access } = await dashboardViewer();
      const { now, period, monthStart } = await dashboardWindow();
      const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
      const monthEnd = addMonths(monthStart, 1);
      const [moneyFmt, target, won, rows, ids] = await Promise.all([
        getRegionalSettings(),
        prisma.target.findFirst({ where: { period, metric: "sales_value" }, select: { value: true } }),
        seesLeads ? wonThisMonthSplit() : null,
        // The forecast page's own loader (tenant-scoped), then narrowed to the viewer's deals.
        seesLeads ? listForecastLeads({ closeFrom: monthStart, closeTo: monthEnd }) : [],
        leadScope(),
      ]);
      const allowed = new Set(ids ?? []);
      const mine = ids === null ? rows : rows.filter((row) => allowed.has(row.id));
      const forecast = summarizeForecast(mine);
      const wonCents = won ? won.base.reduce((sum, w) => sum + w.valueCents, 0) : 0;
      return {
        targetCents: target?.value ?? 0,
        wonCents,
        forecast,
        daysLeft: differenceInCalendarDays(monthEnd, now),
        now,
        moneyFmt,
      };
    },
    ({ targetCents, wonCents, forecast, daysLeft, now, moneyFmt }) => {
      const money = (cents: number) => formatZAR(cents, moneyFmt);
      const pct = targetCents > 0 ? Math.round((wonCents / targetCents) * 100) : null;
      return (
        <SectionCard title="Forecast vs target" action={{ href: "/forecast", label: "Forecast" }}>
          {pct === null ? (
            <Empty>
              No sales target for this month.{" "}
              <Link href="/targets" className="text-primary hover:underline">
                Set one in Targets
              </Link>
              .
            </Empty>
          ) : (
            <>
              <div className="flex items-baseline justify-between text-[13px]">
                <span className="text-muted-foreground">Won of target</span>
                <span className="font-semibold tabular-nums">{pct}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
            </>
          )}
          <ul className="mt-2 divide-y divide-border/50">
            {targetCents > 0 && <MetricRow label="Sales target" value={money(targetCents)} href="/targets" />}
            <MetricRow label="Won so far" value={money(wonCents)} href="/reports" />
            {targetCents > 0 && <MetricRow label="Still to win" value={money(Math.max(0, targetCents - wonCents))} href="/targets" />}
            <MetricRow label="Committed, closing this month" value={money(forecast.commitValueCents)} href="/forecast" />
            <MetricRow label="Weighted forecast, closing this month" value={money(forecast.weightedValueCents)} href="/forecast" />
          </ul>
          <AsOf
            at={now}
            regional={moneyFmt}
            note={`${daysLeft} day${daysLeft === 1 ? "" : "s"} left · base currency${forecast.otherCurrencies.length ? ` · plus ${formatTotals(forecast.otherCurrencies, moneyFmt, true)} in the forecast` : ""}`}
          />
        </SectionCard>
      );
    },
  ),
};
