import Link from "next/link";
import { subDays, addDays, startOfDay, startOfMonth, subMonths } from "date-fns";
import {
  SquareKanban,
  CircleDollarSign,
  Truck,
  Wrench,
  Clock4,
  CarFront,
  Phone,
  Mail,
  MessageCircle,
  Car,
  Users,
  Check,
  TriangleAlert,
  ArrowRight,
  FileSignature,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getAiHealth } from "@/lib/systemHealth";
import { getLastRun } from "@/lib/securityRunbook";
import { CompleteActivityButton, FollowUpPrompts } from "@/components/proactive/NextStep";
import Tabs from "@/components/Tabs";
import { hasModule } from "@/lib/access";
import { formatZARCompact, formatDate, formatDateTime, contactName } from "@/lib/format";
import { computeDue, dueLabels, dueColors } from "@/lib/serviceDue";
import { cn } from "@/lib/utils";
import {
  Stagger,
  StaggerItem,
  StatSparkCard,
  PipelineSnapshot,
  TargetRings,
  type SparkStat,
  type PipeSeg,
  type RingDef,
} from "@/components/dashboard/widgets";

const timeOf = (d: Date) =>
  d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0
    ? d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })
    : null;

/* ── agenda / list building blocks (server-rendered) ─────────────── */

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  call: Phone,
  email: Mail,
  whatsapp: MessageCircle,
  meeting: Users,
  test_drive: Car,
};

type DashActivity = {
  id: string;
  type: string;
  category: string | null;
  summary: string;
  dueDate: Date;
  assignedTo: { name: string };
  lead: { id: string; name: string } | null;
  contact: { id: string; firstName: string; lastName: string | null; isCompany: boolean; company: string | null } | null;
};

function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        {action && (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
            <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function ActivityRow({ a, highlightOverdue }: { a: DashActivity; highlightOverdue?: boolean }) {
  const startOfToday = startOfDay(new Date());
  const overdue = highlightOverdue && a.dueDate < startOfToday;
  const Icon = a.category === "workshop" ? Wrench : ACTIVITY_ICONS[a.type] ?? Check;
  const who = a.lead ? (
    <Link href={`/leads/${a.lead.id}`} className="text-primary hover:underline">
      {a.lead.name}
    </Link>
  ) : a.contact ? (
    <Link href={`/contacts/${a.contact.id}`} className="text-primary hover:underline">
      {contactName(a.contact)}
    </Link>
  ) : null;
  return (
    <li className="group flex items-center gap-2.5 py-1.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md",
          overdue ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
        )}
      >
        {overdue ? <TriangleAlert className="size-3.5" /> : <Icon className="size-3.5" />}
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {timeOf(a.dueDate) && (
          <span className="font-semibold tabular-nums text-primary">{timeOf(a.dueDate)} </span>
        )}
        {a.summary}
        <span className="text-[11px] text-muted-foreground">
          {" — "}
          {who ?? "general"} · {a.assignedTo.name.split(" ")[0]}
          {overdue && <span className="text-destructive"> · {formatDate(a.dueDate)}</span>}
        </span>
      </p>
      <span className="shrink-0">
        <CompleteActivityButton activityId={a.id} />
      </span>
    </li>
  );
}

/** Today + tomorrow merged into one card with day dividers — no empty panels. */
function AgendaCard({
  today,
  tomorrow,
  action,
}: {
  today: DashActivity[];
  tomorrow: DashActivity[];
  action?: { href: string; label: string };
}) {
  const DayLabel = ({ children }: { children: React.ReactNode }) => (
    <p className="pb-0.5 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/60 first:pt-0">
      {children}
    </p>
  );
  return (
    <SectionCard title="Agenda" action={action}>
      <DayLabel>Today</DayLabel>
      {today.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground/60">Nothing due today.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {today.map((a) => (
            <ActivityRow key={a.id} a={a} highlightOverdue />
          ))}
        </ul>
      )}
      <DayLabel>Tomorrow</DayLabel>
      {tomorrow.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground/60">Nothing planned yet.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {tomorrow.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ── helpers ──────────────────────────────────────────────────────── */

/** Daily counts (index 0 = 1st of the month) for sparklines. */
function dailySeries(dates: Date[], daysInSeries: number, value?: (i: number) => number) {
  const out = new Array(Math.max(2, daysInSeries)).fill(0);
  dates.forEach((d, i) => {
    const idx = d.getDate() - 1;
    if (idx >= 0 && idx < out.length) out[idx] += value ? value(i) : 1;
  });
  return out;
}

const pctDelta = (cur: number, prev: number): number | null =>
  prev === 0 ? (cur > 0 ? 100 : null) : Math.round(((cur - prev) / prev) * 100);

/** Label + badge tone for a quote's live signing state. */
const SIGN_STATE: Record<
  string,
  { label: (r: { signedCount: number; totalSigners: number; waitingFor: string | null }) => string; pill: string }
> = {
  sent: { label: (r) => `Sent · waiting for ${r.waitingFor}`, pill: "bg-blue-500/10 text-blue-300" },
  viewed: { label: (r) => `Opened · waiting for ${r.waitingFor}`, pill: "bg-indigo-500/10 text-indigo-300" },
  partial: { label: (r) => `${r.signedCount}/${r.totalSigners} signed · waiting for ${r.waitingFor}`, pill: "bg-amber-500/10 text-amber-300" },
  signed: { label: () => "Fully signed", pill: "bg-emerald-500/10 text-emerald-300" },
};

/* ── page ─────────────────────────────────────────────────────────── */

export default async function DashboardPage() {
  const user = await requireUser();
  const showSales = hasModule(user, "crm");
  const showService = hasModule(user, "workshop");

  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const dayAfterStart = addDays(todayStart, 2);
  const monthStart = startOfMonth(now);
  const prevMonthStart = startOfMonth(subMonths(now, 1));
  // same-days window of last month, for honest deltas mid-month
  const prevSameDay = new Date(prevMonthStart.getTime() + (now.getTime() - monthStart.getTime()));
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [
    openLeads,
    openValue,
    awaitingDelivery,
    openJobCards,
    vehicles,
    recentComms,
    recentLeads,
    todayAll,
    tomorrowAll,
    leadsMTD,
    prevLeadsCount,
    wonMTD,
    prevWon,
    deliveriesMTD,
    servicesMTD,
    prevServices,
    targets,
    openByStage,
    myOverdue,
    noNextLeads,
    staleQuotes,
    newLeadsCount,
  ] = await Promise.all([
    prisma.lead.count({ where: { status: "open" } }),
    prisma.lead.aggregate({ where: { status: "open" }, _sum: { valueCents: true } }),
    prisma.quote.count({ where: { status: "accepted", deliveredAt: null, supersededAt: null } }),
    prisma.jobCard.count({ where: { status: { not: "completed" } } }),
    prisma.vehicle.findMany({
      include: {
        contact: true,
        serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
        mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
      },
    }),
    prisma.communication.findMany({
      where: { subject: { not: "🔎 AI research" } },
      take: 5,
      orderBy: { occurredAt: "desc" },
      include: { user: true, contact: true, lead: true },
    }),
    prisma.lead.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { product: true, stage: true },
    }),
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { lt: tomorrowStart } },
      orderBy: { dueDate: "asc" },
      include: { lead: true, contact: true, assignedTo: true },
      take: 20,
    }),
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { gte: tomorrowStart, lt: dayAfterStart } },
      orderBy: { dueDate: "asc" },
      include: { lead: true, contact: true, assignedTo: true },
      take: 20,
    }),
    prisma.lead.findMany({
      where: { createdAt: { gte: monthStart } },
      select: { createdAt: true },
    }),
    prisma.lead.count({ where: { createdAt: { gte: prevMonthStart, lt: prevSameDay } } }),
    // updatedAt ≈ when the deal was marked won
    prisma.lead.findMany({
      where: { status: "won", updatedAt: { gte: monthStart } },
      select: { updatedAt: true, valueCents: true },
    }),
    prisma.lead.findMany({
      where: { status: "won", updatedAt: { gte: prevMonthStart, lt: prevSameDay } },
      select: { valueCents: true },
    }),
    prisma.quote.count({ where: { deliveredAt: { gte: monthStart } } }),
    prisma.jobCard.findMany({
      where: { status: "completed", completedAt: { gte: monthStart } },
      select: { completedAt: true },
    }),
    prisma.jobCard.count({
      where: { status: "completed", completedAt: { gte: prevMonthStart, lt: prevSameDay } },
    }),
    prisma.target.findMany({ where: { period } }),
    prisma.lead.findMany({
      where: { status: "open" },
      select: { valueCents: true, stage: { select: { id: true, name: true, color: true, order: true } } },
    }),
    // My overdue items — the on-open "did this happen?" queue (capped client-side)
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { lt: todayStart }, assignedToId: user.id },
      orderBy: { dueDate: "asc" },
      take: 3,
      include: { lead: true },
    }),
    // Attention: open leads with nothing planned — the #1 cause of pipeline rot
    prisma.lead.findMany({
      where: { status: "open", activities: { none: { status: "planned" } } },
      select: { id: true, name: true, stage: { select: { name: true, color: true } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
    // Attention: quotes sent but unsigned for 3+ days — time to call
    prisma.quote.findMany({
      where: {
        status: "sent",
        supersededAt: null,
        signedAt: null,
        createdAt: { lt: subDays(now, 3) },
      },
      select: { id: true, number: true, createdAt: true, lead: { select: { name: true } }, contact: { select: { firstName: true, lastName: true, isCompany: true, company: true } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
    // Brand-new leads: open and never opened by anyone yet (viewedAt still null).
    prisma.lead.count({ where: { status: "open", viewedAt: null } }),
  ]);

  const salesToday = todayAll.filter((a) => a.category !== "workshop");
  const salesTomorrow = tomorrowAll.filter((a) => a.category !== "workshop");
  const shopToday = todayAll.filter((a) => a.category === "workshop");
  const shopTomorrow = tomorrowAll.filter((a) => a.category === "workshop");

  const dueVehicles = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((x) => x.due.status === "overdue" || x.due.status === "due_soon")
    .sort((a, b) => (a.due.status === "overdue" ? -1 : 1) - (b.due.status === "overdue" ? -1 : 1));

  // Quote + signing lifecycle events (created, sent, countersigned, signed, …)
  // live in the audit log, not communications — pull them so the feed shows the
  // whole picture, not just calls/notes/new leads.
  const recentActivity = await prisma.auditLog.findMany({
    where: { OR: [{ action: { startsWith: "quote." } }, { action: { startsWith: "signing." } }] },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { id: true, action: true, summary: true, createdAt: true, contactId: true, leadId: true },
  });

  // Quotes currently out for signature → a live-status card. The card is rendered
  // only when at least one quote signing request is active (sent/viewed/in progress).
  const activeSignRequests = await prisma.signatureRequest.findMany({
    where: { quoteId: { not: null }, deletedAt: null, status: { in: ["sent", "viewed", "in_progress"] } },
    orderBy: { updatedAt: "desc" },
    take: 12,
    select: {
      quoteId: true,
      status: true,
      recipients: { orderBy: { order: "asc" }, select: { name: true, role: true, status: true, viewedAt: true } },
    },
  });
  const signQuoteIds = [...new Set(activeSignRequests.map((r) => r.quoteId).filter((v): v is string => Boolean(v)))];
  const signQuotes = signQuoteIds.length
    ? await prisma.quote.findMany({
        where: { id: { in: signQuoteIds }, deletedAt: null },
        select: {
          id: true,
          number: true,
          lead: { select: { name: true } },
          contact: { select: { firstName: true, lastName: true, isCompany: true, company: true } },
        },
      })
    : [];
  const signQuoteById = new Map(signQuotes.map((q) => [q.id, q]));

  const signingRows = activeSignRequests
    .map((r) => {
      const q = r.quoteId ? signQuoteById.get(r.quoteId) : null;
      if (!q) return null;
      const signers = r.recipients.filter((x) => x.role !== "viewer");
      const next = signers.find((x) => x.status !== "signed" && x.status !== "declined");
      const signedCount = signers.filter((x) => x.status === "signed").length;
      const anyViewed = r.status === "viewed" || r.status === "in_progress" || signers.some((x) => x.viewedAt);
      const state: "sent" | "viewed" | "partial" | "signed" = !next
        ? "signed"
        : signedCount > 0
        ? "partial"
        : anyViewed
        ? "viewed"
        : "sent";
      return {
        id: q.id,
        number: q.number,
        who: q.lead?.name ?? (q.contact ? contactName(q.contact) : "customer"),
        waitingFor: next ? next.name.split(" ")[0] : null,
        signedCount,
        totalSigners: signers.length,
        state,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // One chronological feed: new leads + logged communications + quote/signing events
  const feed = [
    ...recentLeads.map((l) => ({ kind: "lead" as const, when: l.createdAt, lead: l })),
    ...recentComms.map((c) => ({ kind: "comm" as const, when: c.occurredAt, comm: c })),
    ...recentActivity.map((a) => ({ kind: "audit" as const, when: a.createdAt, audit: a })),
  ]
    .sort((a, b) => b.when.getTime() - a.when.getTime())
    .slice(0, 8);

  /* Sparkline + stat data (this month) */
  const daysSoFar = now.getDate();
  const wonValueMTD = wonMTD.reduce((s, w) => s + w.valueCents, 0);
  const prevWonValue = prevWon.reduce((s, w) => s + w.valueCents, 0);

  const salesStats: { stat: SparkStat; icon: React.ReactNode }[] = [
    {
      icon: <SquareKanban />,
      stat: {
        label: "New leads (month)",
        value: leadsMTD.length,
        delta: pctDelta(leadsMTD.length, prevLeadsCount),
        href: "/leads",
        spark: dailySeries(leadsMTD.map((l) => l.createdAt), daysSoFar),
      },
    },
    {
      icon: <CircleDollarSign />,
      stat: {
        label: "Won value (month)",
        value: Math.round(wonValueMTD / 100),
        display: "zar",
        delta: pctDelta(wonValueMTD, prevWonValue),
        href: "/reports",
        spark: dailySeries(wonMTD.map((w) => w.updatedAt), daysSoFar, (i) =>
          Math.round(wonMTD[i].valueCents / 100)
        ),
      },
    },
    {
      icon: <SquareKanban />,
      stat: {
        label: "Open leads",
        value: openLeads,
        delta: null,
        href: "/leads",
        spark: dailySeries(leadsMTD.map((l) => l.createdAt), daysSoFar),
      },
    },
    {
      icon: <Truck />,
      stat: { label: "To deliver", value: awaitingDelivery, delta: null, href: "/deliveries", spark: [] },
    },
  ];

  const serviceStats: { stat: SparkStat; icon: React.ReactNode }[] = [
    {
      icon: <Wrench />,
      stat: { label: "Open job cards", value: openJobCards, delta: null, href: "/jobcards", spark: [] },
    },
    {
      icon: <Check />,
      stat: {
        label: "Services (month)",
        value: servicesMTD.length,
        delta: pctDelta(servicesMTD.length, prevServices),
        href: "/jobcards",
        spark: dailySeries(servicesMTD.map((j) => j.completedAt!), daysSoFar),
      },
    },
    {
      icon: <Clock4 />,
      stat: {
        label: "Service due",
        value: dueVehicles.length,
        delta: null,
        href: "/service-due",
        spark: [],
        tone: dueVehicles.length > 0 ? "warn" : "default",
      },
    },
    {
      icon: <CarFront />,
      stat: { label: "Fleet", value: vehicles.length, delta: null, href: "/vehicles", spark: [] },
    },
  ];

  /* Pipeline snapshot */
  const segMap = new Map<string, PipeSeg & { order: number }>();
  for (const l of openByStage) {
    const cur =
      segMap.get(l.stage.id) ??
      { name: l.stage.name, color: l.stage.color, count: 0, value: 0, order: l.stage.order };
    cur.count += 1;
    cur.value += l.valueCents;
    segMap.set(l.stage.id, cur);
  }
  const segments = [...segMap.values()].sort((a, b) => a.order - b.order);

  /* Target rings */
  const tMap = new Map(targets.map((t) => [t.metric, t.value]));
  const rings: RingDef[] = [
    { label: "Leads", actual: leadsMTD.length, target: tMap.get("leads") ?? 0, display: "int", color: "var(--chart-2)" },
    { label: "Sales", actual: Math.round(wonValueMTD / 100), target: Math.round((tMap.get("sales_value") ?? 0) / 100), display: "zar", color: "var(--chart-1)" },
    { label: "Deliveries", actual: deliveriesMTD, target: tMap.get("deliveries") ?? 0, display: "int", color: "var(--chart-3)" },
    { label: "Services", actual: servicesMTD.length, target: tMap.get("services") ?? 0, display: "int", color: "var(--chart-4)" },
  ];

  // Proactive system alerts — problems surface HERE before customers notice
  const [aiHealth, lastSecurity] = await Promise.all([getAiHealth(), getLastRun()]);
  const systemAlerts: { text: string; href: string }[] = [];
  if (aiHealth && ["billing", "auth", "error"].includes(aiHealth.status)) {
    systemAlerts.push({ text: `AI assistant problem: ${aiHealth.detail}`, href: "/settings/security" });
  }
  if (user.role === "owner" && lastSecurity && lastSecurity.failed > 0) {
    systemAlerts.push({
      text: `Security runbook: ${lastSecurity.failed} check(s) failing`,
      href: "/settings/security",
    });
  }

  const hour = Number(
    now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" })
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(/\s+/)[0];
  const dueTodayCount = todayAll.length;

  const statGrid = (stats: { stat: SparkStat; icon: React.ReactNode }[]) => (
    <Stagger className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {stats.map(({ stat, icon }) => (
        <StaggerItem key={stat.label}>
          <StatSparkCard stat={stat} icon={icon} />
        </StaggerItem>
      ))}
    </Stagger>
  );

  return (
    <div className="space-y-5">
      <FollowUpPrompts
        prompts={myOverdue.map((a) => ({
          id: a.id,
          type: a.type,
          summary: a.summary,
          dueLabel: formatDate(a.dueDate),
          leadId: a.leadId,
          leadName: a.lead?.name ?? null,
        }))}
      />
      {systemAlerts.map((a) => (
        <Link
          key={a.text}
          href={a.href}
          className="flex items-center gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-200 transition-colors hover:bg-red-500/15"
        >
          <TriangleAlert className="size-4 shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 truncate">{a.text}</span>
          <ArrowRight className="size-4 shrink-0 text-red-400" />
        </Link>
      ))}

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {greeting}, {firstName}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {dueTodayCount === 0
            ? "Nothing on the agenda today — a clean slate."
            : `${dueTodayCount} ${dueTodayCount === 1 ? "item" : "items"} on today's agenda.`}
        </p>
      </div>

      <Tabs
        tabs={[
          ...(showSales ? [{
            key: "sales",
            label: "Sales",
            count: salesToday.length,
            content: (
              <div className="space-y-4">
                {statGrid(salesStats)}

                <div className="grid items-stretch gap-4 lg:grid-cols-3">
                  <div className="grid min-w-0 gap-4 sm:grid-cols-3 lg:col-span-2">
                    {/* Brand-new leads — untouched since they came in */}
                    <Link
                      href="/leads"
                      className={`group flex min-w-0 flex-col justify-between rounded-xl border p-4 shadow-sm transition-colors sm:col-span-1 ${
                        newLeadsCount > 0
                          ? "border-emerald-500/30 bg-emerald-500/[0.07] hover:border-emerald-500/50"
                          : "border-border bg-card hover:border-primary/30"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Brand-new
                        </p>
                        <Sparkles className={`size-4 ${newLeadsCount > 0 ? "text-emerald-400" : "text-muted-foreground"}`} />
                      </div>
                      <div className="mt-2">
                        <div className={`text-3xl font-bold tabular-nums ${newLeadsCount > 0 ? "text-emerald-300" : "text-foreground"}`}>
                          {newLeadsCount}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {newLeadsCount === 1 ? "lead not opened yet" : "leads not opened yet"}
                        </p>
                      </div>
                      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary group-hover:underline">
                        {newLeadsCount > 0 ? "Review now" : "All caught up"}
                        <ArrowRight className="size-3" />
                      </span>
                    </Link>

                    {/* Pipeline snapshot */}
                    <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm sm:col-span-2">
                      <div className="mb-3 flex items-center justify-between">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Pipeline snapshot
                        </p>
                        <Link
                          href="/leads"
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          Board
                          <ArrowRight className="size-3" />
                        </Link>
                      </div>
                      <PipelineSnapshot
                        segments={segments}
                        totalValue={formatZARCompact(openValue._sum.valueCents ?? 0)}
                      />
                    </div>
                  </div>
                  <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Month targets
                      </p>
                      <Link
                        href="/targets"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Targets
                        <ArrowRight className="size-3" />
                      </Link>
                    </div>
                    <TargetRings rings={rings} />
                  </div>
                </div>

                <div className="grid items-start gap-4 lg:grid-cols-2">
                  <AgendaCard
                    today={salesToday}
                    tomorrow={salesTomorrow}
                    action={{ href: "/calendar", label: "Calendar" }}
                  />

                  <div className="space-y-4">
                  {signingRows.length > 0 && (
                    <SectionCard title="Out for signature" action={{ href: "/signatures", label: "Signatures" }}>
                      <ul className="divide-y divide-border/50">
                        {signingRows.map((s) => {
                          const meta = SIGN_STATE[s.state];
                          return (
                            <li key={s.id} className="flex items-center gap-2.5 py-1.5">
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <FileSignature className="size-3.5" />
                              </span>
                              <p className="min-w-0 flex-1 truncate text-[13px]">
                                <Link href={`/quotes/${s.id}`} className="font-medium text-foreground hover:text-primary">
                                  Q-{s.number}
                                </Link>
                                <span className="text-[11px] text-muted-foreground"> — {s.who}</span>
                              </p>
                              <span className={`badge shrink-0 ${meta.pill}`}>{meta.label(s)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </SectionCard>
                  )}

                  <SectionCard title="Needs attention" action={{ href: "/leads", label: "Board" }}>
                    {noNextLeads.length === 0 && staleQuotes.length === 0 ? (
                      <p className="py-2 text-xs text-muted-foreground/70">
                        All clear — every open lead has a next step. 🎉
                      </p>
                    ) : (
                      <ul className="divide-y divide-border/50">
                        {noNextLeads.map((l) => (
                          <li key={l.id} className="flex items-center gap-2.5 py-1.5">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-300">
                              <TriangleAlert className="size-3.5" />
                            </span>
                            <p className="min-w-0 flex-1 truncate text-[13px]">
                              <Link href={`/leads/${l.id}`} className="font-medium text-foreground hover:text-primary">
                                {l.name}
                              </Link>
                              <span className="text-[11px] text-muted-foreground"> — no next step planned</span>
                            </p>
                            <span className="badge shrink-0 text-white" style={{ backgroundColor: l.stage.color }}>
                              {l.stage.name}
                            </span>
                          </li>
                        ))}
                        {staleQuotes.map((q) => (
                          <li key={q.id} className="flex items-center gap-2.5 py-1.5">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-300">
                              <Clock4 className="size-3.5" />
                            </span>
                            <p className="min-w-0 flex-1 truncate text-[13px]">
                              <Link href={`/quotes/${q.id}`} className="font-medium text-foreground hover:text-primary">
                                Q-{q.number}
                              </Link>
                              <span className="text-[11px] text-muted-foreground">
                                {` — ${q.lead?.name ?? (q.contact ? contactName(q.contact) : "customer")} · sent ${formatDate(q.createdAt)}, still unsigned — call them`}
                              </span>
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </SectionCard>

                  <SectionCard title="Latest activity" action={{ href: "/leads", label: "Pipeline" }}>
                    <ul className="divide-y divide-border/50">
                      {feed.length === 0 && (
                        <li className="py-2 text-xs text-muted-foreground/70">Nothing yet.</li>
                      )}
                      {feed.map((f) =>
                        f.kind === "lead" ? (
                          <li key={`l-${f.lead.id}`} className="flex items-center gap-2 py-1.5">
                            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                            <p className="min-w-0 flex-1 truncate text-[13px]">
                              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Lead ·{" "}
                              </span>
                              <Link
                                href={`/leads/${f.lead.id}`}
                                className="font-medium text-foreground hover:text-primary"
                              >
                                {f.lead.name}
                              </Link>
                              <span className="text-[11px] text-muted-foreground">
                                {" — "}
                                {f.lead.product ? `${f.lead.product.name} · ` : ""}
                                {f.lead.source} · {formatDate(f.lead.createdAt)}
                              </span>
                            </p>
                            <span
                              className="badge shrink-0 text-white"
                              style={{ backgroundColor: f.lead.stage.color }}
                            >
                              {f.lead.status === "open" ? f.lead.stage.name : f.lead.status}
                            </span>
                          </li>
                        ) : f.kind === "comm" ? (
                          <li key={`c-${f.comm.id}`} className="flex items-center gap-2 py-1.5">
                            <span className="size-1.5 shrink-0 rounded-full bg-sky-400" />
                            <p className="min-w-0 flex-1 truncate text-[13px]">
                              <span className="text-[11px] capitalize uppercase tracking-wide text-muted-foreground">
                                {f.comm.type} ·{" "}
                              </span>
                              {f.comm.contact ? (
                                <Link
                                  href={`/contacts/${f.comm.contact.id}`}
                                  className="font-medium text-foreground hover:text-primary"
                                >
                                  {contactName(f.comm.contact)}
                                </Link>
                              ) : f.comm.lead ? (
                                <Link
                                  href={`/leads/${f.comm.lead.id}`}
                                  className="font-medium text-foreground hover:text-primary"
                                >
                                  {f.comm.lead.name}
                                </Link>
                              ) : (
                                "—"
                              )}
                              <span className="text-[11px] text-muted-foreground">
                                {" · "}
                                {f.comm.body.slice(0, 56)} · {formatDateTime(f.comm.occurredAt)}
                              </span>
                            </p>
                          </li>
                        ) : (
                          <li key={`a-${f.audit.id}`} className="flex items-center gap-2 py-1.5">
                            <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
                            <p className="min-w-0 flex-1 truncate text-[13px]">
                              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                {f.audit.action.startsWith("signing") ? "Signing" : "Quote"} ·{" "}
                              </span>
                              {f.audit.leadId ? (
                                <Link href={`/leads/${f.audit.leadId}`} className="font-medium text-foreground hover:text-primary">{f.audit.summary}</Link>
                              ) : f.audit.contactId ? (
                                <Link href={`/contacts/${f.audit.contactId}`} className="font-medium text-foreground hover:text-primary">{f.audit.summary}</Link>
                              ) : (
                                <span className="font-medium text-foreground">{f.audit.summary}</span>
                              )}
                              <span className="text-[11px] text-muted-foreground"> · {formatDateTime(f.audit.createdAt)}</span>
                            </p>
                          </li>
                        )
                      )}
                    </ul>
                  </SectionCard>
                  </div>
                </div>
              </div>
            ),
          }] : []),
          ...(showService ? [{
            key: "service",
            label: "Service",
            count: shopToday.length + dueVehicles.length,
            content: (
              <div className="space-y-4">
                {statGrid(serviceStats)}
                <div className="grid items-start gap-4 lg:grid-cols-2">
                  <AgendaCard
                    today={shopToday}
                    tomorrow={shopTomorrow}
                    action={{ href: "/workshop-calendar", label: "Calendar" }}
                  />
                  <SectionCard title="Vehicles due for service" action={{ href: "/service-due", label: "Service due" }}>
                  <ul className="divide-y divide-border/60">
                    {dueVehicles.length === 0 && (
                      <li className="py-2 text-xs text-muted-foreground/70">Nothing due. 🎉</li>
                    )}
                    {dueVehicles.slice(0, 10).map(({ vehicle, due }) => (
                      <li key={vehicle.id} className="flex items-center gap-2 py-2">
                        <p className="min-w-0 flex-1 truncate text-[13px]">
                          <Link href={`/vehicles/${vehicle.id}`} className="font-medium text-foreground hover:text-primary">
                            {vehicle.model}
                          </Link>
                          <span className="text-[11px] text-muted-foreground">
                            {" — "}
                            {contactName(vehicle.contact)}
                            {due.nextDueDate ? ` · due ${formatDate(due.nextDueDate)}` : ""}
                            {due.nextDueKm != null ? ` · ${due.nextDueKm.toLocaleString()} km` : ""}
                          </span>
                        </p>
                        <span className={`badge ${dueColors[due.status]} shrink-0`}>
                          {dueLabels[due.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                  </SectionCard>
                </div>
              </div>
            ),
          }] : []),
        ]}
      />
    </div>
  );
}
