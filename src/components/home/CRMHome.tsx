import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Gauge,
  MessageCircle,
  Phone,
  Plus,
  Sparkles,
  Target,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDateTime, formatZARCompact } from "@/lib/format";
import { CompleteActivityButton } from "@/components/proactive/NextStep";
import {
  dashboardViewer,
  dashboardWindow,
  grants,
  leadWhere,
  leadsThisMonth,
  plannedActivities,
  quoteWhere,
  wonThisMonth,
} from "@/lib/dashboard/data";
import { cn } from "@/lib/utils";

const activityIcon = (type: string) => {
  if (type === "call") return Phone;
  if (type === "whatsapp") return MessageCircle;
  return Clock3;
};

export default async function CRMHome({ hasCustomDashboard }: { hasCustomDashboard: boolean }) {
  const { user, access } = await dashboardViewer();
  const { now, todayStart, period } = await dashboardWindow();
  const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
  const seesQuotes = grants(access, "quotes.view_all", "quotes.view_owned");
  const seesActivities = grants(access, "activities.view", "activities.manage");
  const seesAudit = grants(access, "audit.view");

  const [monthLeads, won, openLeads, pipelineRows, attentionLeads, activityWindow, targets, latestLeads, latestAudit, toDeliver] =
    await Promise.all([
      seesLeads ? leadsThisMonth() : [],
      seesLeads ? wonThisMonth() : [],
      seesLeads ? prisma.lead.count({ where: { ...(await leadWhere()), status: "open" } }) : 0,
      seesLeads
        ? prisma.lead.findMany({
            where: { ...(await leadWhere()), status: "open" },
            select: {
              valueCents: true,
              stage: { select: { id: true, name: true, color: true, order: true } },
            },
          })
        : [],
      seesLeads
        ? prisma.lead.findMany({
            where: { ...(await leadWhere()), status: "open", activities: { none: { status: "planned" } } },
            select: { id: true, name: true, stage: { select: { name: true, color: true } } },
            orderBy: { createdAt: "asc" },
            take: 5,
          })
        : [],
      seesActivities ? plannedActivities() : Promise.resolve({ today: [], tomorrow: [] }),
      seesLeads ? prisma.target.findMany({ where: { period } }) : [],
      seesLeads
        ? prisma.lead.findMany({
            where: await leadWhere(),
            orderBy: { createdAt: "desc" },
            take: 5,
            select: {
              id: true,
              name: true,
              source: true,
              createdAt: true,
              stage: { select: { name: true, color: true } },
            },
          })
        : [],
      seesAudit
        ? prisma.auditLog.findMany({
            where: { OR: [{ action: { startsWith: "quote." } }, { action: { startsWith: "signing." } }] },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, action: true, summary: true, createdAt: true },
          })
        : [],
      seesQuotes && access.modules.has("automotive")
        ? prisma.quote.count({
            where: { ...(await quoteWhere()), status: "accepted", deliveredAt: null, supersededAt: null },
          })
        : 0,
    ]);

  const salesToday = activityWindow.today.filter((a) => a.category !== "workshop");
  const salesTomorrow = activityWindow.tomorrow.filter((a) => a.category !== "workshop");
  const overdueCount = salesToday.filter((a) => a.dueDate < todayStart).length;
  const wonValue = won.reduce((sum, row) => sum + row.valueCents, 0);
  const pipelineValue = pipelineRows.reduce((sum, row) => sum + row.valueCents, 0);

  const stageMap = new Map<string, { name: string; color: string; count: number; order: number }>();
  for (const lead of pipelineRows) {
    const current = stageMap.get(lead.stage.id) ?? {
      name: lead.stage.name,
      color: lead.stage.color,
      count: 0,
      order: lead.stage.order,
    };
    current.count += 1;
    stageMap.set(lead.stage.id, current);
  }
  const stages = [...stageMap.values()].sort((a, b) => a.order - b.order);
  const targetMap = new Map(targets.map((target) => [target.metric, target.value]));
  const leadsTarget = targetMap.get("leads") ?? 0;
  const salesTarget = targetMap.get("sales_value") ?? 0;
  const leadProgress = leadsTarget > 0 ? Math.min(100, Math.round((monthLeads.length / leadsTarget) * 100)) : null;
  const salesProgress = salesTarget > 0 ? Math.min(100, Math.round((wonValue / salesTarget) * 100)) : null;

  const latest = [
    ...latestLeads.map((lead) => ({
      id: `lead-${lead.id}`,
      kind: "Lead",
      text: lead.name,
      meta: `${lead.source} · ${lead.stage.name}`,
      when: lead.createdAt,
      href: `/leads/${lead.id}`,
      color: lead.stage.color,
    })),
    ...latestAudit.map((audit) => ({
      id: `audit-${audit.id}`,
      kind: audit.action.startsWith("signing") ? "Signing" : "Quote",
      text: audit.summary,
      meta: "",
      when: audit.createdAt,
      href: null as string | null,
      color: "var(--primary)",
    })),
  ]
    .sort((a, b) => b.when.getTime() - a.when.getTime())
    .slice(0, 7);

  const hour = Number(
    now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" }),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(/\s+/)[0];
  const dateLabel = now.toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Africa/Johannesburg",
  });

  const metrics = [
    { label: "New leads", value: String(monthLeads.length), detail: "this month", icon: UserPlus, href: "/leads" },
    { label: "Open pipeline", value: formatZARCompact(pipelineValue), detail: `${openLeads} active leads`, icon: Gauge, href: "/leads" },
    { label: "Won", value: formatZARCompact(wonValue), detail: "this month", icon: CircleDollarSign, href: "/reports" },
    ...(access.modules.has("automotive")
      ? [{ label: "To deliver", value: String(toDeliver), detail: "accepted deals", icon: CheckCircle2, href: "/deliveries" }]
      : []),
  ];

  return (
    <main className="mx-auto w-full max-w-[1500px] space-y-7 pb-10">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CalendarDays className="size-4" aria-hidden="true" />
            {dateLabel}
          </p>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-[2.65rem]">
            {greeting}, {firstName}
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            {salesToday.length === 0
              ? "You have a clear sales agenda today."
              : `${salesToday.length} ${salesToday.length === 1 ? "action" : "actions"} today${overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/leads/new"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Plus className="size-4" /> New lead
          </Link>
          <Link
            href="/calendar"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border/70 bg-card px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted/60"
          >
            <CalendarDays className="size-4 text-muted-foreground" /> Calendar
          </Link>
          {hasCustomDashboard && (
            <Link
              href="/d/home"
              className="inline-flex min-h-11 items-center rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
            >
              Custom dashboard <ChevronRight className="ml-1 size-4" />
            </Link>
          )}
        </div>
      </header>

      <section className="overflow-hidden rounded-[26px] border border-border/50 bg-[linear-gradient(135deg,var(--card),color-mix(in_srgb,var(--card)_84%,var(--primary)_16%))] shadow-[0_18px_55px_rgba(0,0,0,0.18)]">
        <div className={cn("grid divide-y divide-border/40 sm:grid-cols-2 sm:divide-x sm:divide-y-0", metrics.length === 4 && "xl:grid-cols-4")}>
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <Link key={metric.label} href={metric.href} className="group px-5 py-5 sm:px-6 sm:py-6">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
                  <Icon className="size-4 text-muted-foreground/55 transition-colors group-hover:text-primary" />
                </div>
                <p className="mt-4 text-3xl font-semibold tracking-[-0.045em] text-foreground sm:text-4xl">{metric.value}</p>
                <p className="mt-1 text-sm text-muted-foreground">{metric.detail}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.75fr)]">
        <section className="overflow-hidden rounded-[26px] border border-border/55 bg-card shadow-[0_16px_45px_rgba(0,0,0,0.14)]">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-xl font-semibold tracking-tight text-foreground">Today</h2>
                {overdueCount > 0 && (
                  <span className="rounded-full bg-destructive/12 px-2.5 py-1 text-xs font-semibold text-destructive">
                    {overdueCount} overdue
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Your next customer actions, in order.</p>
            </div>
            <Link href="/calendar" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
              Full calendar <ArrowRight className="size-4" />
            </Link>
          </div>

          {salesToday.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Sparkles className="mx-auto size-6 text-primary" />
              <p className="mt-3 text-base font-medium text-foreground">Nothing due today</p>
              <p className="mt-1 text-sm text-muted-foreground">A good time to work the pipeline or schedule follow-ups.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/45 border-t border-border/40">
              {salesToday.slice(0, 8).map((activity) => {
                const overdue = activity.dueDate < todayStart;
                const Icon = activityIcon(activity.type);
                const time = activity.dueDate.toLocaleTimeString("en-ZA", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Africa/Johannesburg",
                });
                const customer = activity.lead?.name ?? (activity.contact ? contactName(activity.contact) : "General");
                const href = activity.lead ? `/leads/${activity.lead.id}` : activity.contact ? `/contacts/${activity.contact.id}` : "/calendar";
                return (
                  <li key={activity.id} className="group grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-4 transition-colors hover:bg-muted/30 sm:px-6">
                    <div>
                      <p className={cn("text-sm font-semibold tabular-nums", overdue ? "text-destructive" : "text-foreground")}>{time}</p>
                      {overdue && <p className="mt-0.5 text-[11px] font-medium text-destructive">overdue</p>}
                    </div>
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[15px] font-medium leading-5 text-foreground">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{activity.summary}</span>
                      </p>
                      <Link href={href} className="mt-1 inline-block text-sm text-muted-foreground hover:text-primary hover:underline">
                        {customer}
                      </Link>
                    </div>
                    <div className="opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <CompleteActivityButton activityId={activity.id} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {salesTomorrow.length > 0 && (
            <div className="border-t border-border/45 bg-muted/15 px-5 py-4 sm:px-6">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium text-foreground">Tomorrow</p>
                <p className="text-sm text-muted-foreground">{salesTomorrow.length} planned</p>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {salesTomorrow.slice(0, 3).map((activity) => (
                  <span key={activity.id}>{activity.lead?.name ?? activity.contact?.firstName ?? activity.summary}</span>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="space-y-6">
          <section className="rounded-[26px] border border-border/55 bg-card p-5 shadow-[0_14px_40px_rgba(0,0,0,0.12)] sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Open pipeline</p>
                <p className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-foreground">{formatZARCompact(pipelineValue)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{openLeads} active opportunities</p>
              </div>
              <Link href="/leads" className="rounded-xl bg-muted/55 p-2.5 text-muted-foreground transition hover:text-foreground" aria-label="Open pipeline">
                <ArrowRight className="size-4" />
              </Link>
            </div>

            <div className="mt-6 h-2 overflow-hidden rounded-full bg-muted/55">
              <div className="flex h-full w-full gap-0.5">
                {stages.filter((stage) => stage.count > 0).map((stage) => (
                  <span key={stage.name} style={{ backgroundColor: stage.color, flexGrow: stage.count, flexBasis: 0 }} />
                ))}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
              {stages.map((stage) => (
                <div key={stage.name} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: stage.color }} />
                    <span className="truncate">{stage.name}</span>
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">{stage.count}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[26px] border border-border/55 bg-card p-5 shadow-[0_14px_40px_rgba(0,0,0,0.12)] sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-foreground">Monthly pace</h2>
                <p className="mt-1 text-sm text-muted-foreground">Progress against your targets.</p>
              </div>
              <Target className="size-5 text-muted-foreground/60" />
            </div>

            {leadProgress === null && salesProgress === null ? (
              <Link href="/targets" className="mt-5 flex items-center justify-between rounded-2xl bg-muted/35 px-4 py-4 transition hover:bg-muted/55">
                <div>
                  <p className="text-sm font-medium text-foreground">Set monthly targets</p>
                  <p className="mt-1 text-xs text-muted-foreground">Turn activity into visible progress.</p>
                </div>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            ) : (
              <div className="mt-5 space-y-5">
                {leadProgress !== null && (
                  <Progress label="Leads" value={`${monthLeads.length} / ${leadsTarget}`} percent={leadProgress} />
                )}
                {salesProgress !== null && (
                  <Progress label="Sales" value={`${formatZARCompact(wonValue)} / ${formatZARCompact(salesTarget)}`} percent={salesProgress} />
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="rounded-[26px] border border-border/55 bg-card p-5 shadow-[0_12px_34px_rgba(0,0,0,0.1)] sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">Needs attention</h2>
              <p className="mt-1 text-sm text-muted-foreground">Open leads with no next step planned.</p>
            </div>
            <Link href="/leads/attention" className="text-sm font-medium text-muted-foreground hover:text-foreground">View all</Link>
          </div>

          {attentionLeads.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">Everything has a next action.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border/40">
              {attentionLeads.map((lead) => (
                <li key={lead.id}>
                  <Link href={`/leads/${lead.id}`} className="group flex items-center gap-3 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive">
                      <TriangleAlert className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{lead.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">No next step planned</p>
                    </div>
                    <span className="rounded-full px-2.5 py-1 text-xs font-semibold text-white" style={{ backgroundColor: lead.stage.color }}>
                      {lead.stage.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[26px] border border-border/55 bg-card p-5 shadow-[0_12px_34px_rgba(0,0,0,0.1)] sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">Recent movement</h2>
              <p className="mt-1 text-sm text-muted-foreground">New leads and commercial events.</p>
            </div>
          </div>
          <ul className="mt-4 divide-y divide-border/40">
            {latest.map((item) => {
              const content = (
                <div className="flex min-w-0 items-start gap-3 py-3.5">
                  <span className="mt-2 size-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{item.text}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {item.kind}{item.meta ? ` · ${item.meta}` : ""} · {formatDateTime(item.when)}
                    </p>
                  </div>
                </div>
              );
              return <li key={item.id}>{item.href ? <Link href={item.href}>{content}</Link> : content}</li>;
            })}
          </ul>
        </section>
      </div>
    </main>
  );
}

function Progress({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{value}</p>
        </div>
        <span className="text-sm font-semibold tabular-nums text-foreground">{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted/60">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
