import Link from "next/link";
import { subDays, addDays, startOfDay } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { runIdleAutomations } from "@/lib/automations";
import { completeActivity } from "@/app/actions/activities";
import { activityIcons } from "@/components/ActivityPanel";
import Tabs from "@/components/Tabs";
import { formatZAR, formatDate, formatDateTime, contactName } from "@/lib/format";
import { computeDue, dueLabels, dueColors } from "@/lib/serviceDue";

type DashActivity = {
  id: string;
  type: string;
  category: string | null;
  summary: string;
  dueDate: Date;
  assignedTo: { name: string };
  lead: { id: string; name: string; title: string } | null;
  contact: { id: string; firstName: string; lastName: string | null; isCompany: boolean; company: string | null } | null;
};

function ActivityBlock({
  title,
  items,
  emptyText,
  highlightOverdue,
}: {
  title: string;
  items: DashActivity[];
  emptyText: string;
  highlightOverdue?: boolean;
}) {
  const startOfToday = startOfDay(new Date());
  return (
    <div className="card">
      <h2 className="font-semibold mb-3">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {items.map((a) => {
            const overdue = highlightOverdue && a.dueDate < startOfToday;
            return (
              <li key={a.id} className="py-2 flex items-center gap-3">
                <span className="w-6 text-center shrink-0">
                  {a.category === "workshop" ? "🔧" : activityIcons[a.type] ?? "☑️"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {overdue && <span className="text-red-400 font-semibold">⚠ </span>}
                    {a.summary}
                  </p>
                  <p className="text-xs text-slate-400 truncate">
                    {a.lead ? (
                      <Link href={`/leads/${a.lead.id}`} className="text-orange-400 hover:underline">
                        {a.lead.name}
                      </Link>
                    ) : a.contact ? (
                      <Link href={`/contacts/${a.contact.id}`} className="text-orange-400 hover:underline">
                        {contactName(a.contact)}
                      </Link>
                    ) : (
                      "General"
                    )}
                    {overdue ? (
                      <span className="text-red-400"> · overdue since {formatDate(a.dueDate)}</span>
                    ) : null}
                    {" · "}
                    {a.assignedTo.name}
                  </p>
                </div>
                <form action={completeActivity.bind(null, a.id)}>
                  <input type="hidden" name="revalidate" value="/" />
                  <button className="btn-secondary btn-sm shrink-0">✓</button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatCards({ stats }: { stats: { label: string; value: string; href: string }[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((s) => (
        <Link key={s.label} href={s.href} className="card hover:border-orange-600/60 transition-colors">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{s.label}</p>
          <p className="text-2xl font-bold mt-1">{s.value}</p>
        </Link>
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  await requireUser();
  // Opportunistic sweep of idle-lead automation rules (also exposed as a cron endpoint)
  try {
    await runIdleAutomations();
  } catch {}

  const now = new Date();
  const weekAgo = subDays(now, 7);
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const dayAfterStart = addDays(todayStart, 2);

  const [
    openLeads,
    openValue,
    newThisWeek,
    awaitingDelivery,
    openJobCards,
    vehicles,
    recentComms,
    recentLeads,
    todayActivities,
    tomorrowActivities,
  ] = await Promise.all([
    prisma.lead.count({ where: { status: "open" } }),
    prisma.lead.aggregate({ where: { status: "open" }, _sum: { valueCents: true } }),
    prisma.lead.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.quote.count({ where: { status: "accepted", deliveredAt: null, supersededAt: null } }),
    prisma.jobCard.count({ where: { status: { not: "completed" } } }),
    prisma.vehicle.findMany({
      include: { contact: true, serviceRecords: true, mileageLogs: true },
    }),
    prisma.communication.findMany({
      take: 6,
      orderBy: { occurredAt: "desc" },
      include: { user: true, contact: true, lead: true },
    }),
    prisma.lead.findMany({
      take: 6,
      orderBy: { createdAt: "desc" },
      include: { product: true, stage: true },
    }),
    // Today includes anything overdue — it still needs doing today
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { lt: tomorrowStart } },
      orderBy: { dueDate: "asc" },
      include: { lead: true, contact: true, assignedTo: true },
      take: 12,
    }),
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { gte: tomorrowStart, lt: dayAfterStart } },
      orderBy: { dueDate: "asc" },
      include: { lead: true, contact: true, assignedTo: true },
      take: 12,
    }),
  ]);

  const dueVehicles = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((x) => x.due.status === "overdue" || x.due.status === "due_soon")
    .sort((a, b) => (a.due.status === "overdue" ? -1 : 1) - (b.due.status === "overdue" ? -1 : 1));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <ActivityBlock
          title="📌 Today"
          items={todayActivities}
          emptyText="Nothing due today. 🎉"
          highlightOverdue
        />
        <ActivityBlock
          title="🗓 Tomorrow"
          items={tomorrowActivities}
          emptyText="Nothing planned for tomorrow yet."
        />
      </div>

      <Tabs
        tabs={[
          {
            key: "sales",
            label: "Sales",
            content: (
              <>
                <StatCards
                  stats={[
                    { label: "Open leads", value: String(openLeads), href: "/leads" },
                    {
                      label: "Pipeline value",
                      value: formatZAR(openValue._sum.valueCents ?? 0),
                      href: "/leads",
                    },
                    { label: "New leads (7 days)", value: String(newThisWeek), href: "/leads" },
                    {
                      label: "Awaiting delivery",
                      value: String(awaitingDelivery),
                      href: "/deliveries",
                    },
                  ]}
                />
                <div className="grid lg:grid-cols-2 gap-6 mt-6 items-start">
                  <div className="card">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-semibold">Latest leads</h2>
                      <Link href="/leads" className="text-sm text-orange-400 hover:underline">
                        Pipeline →
                      </Link>
                    </div>
                    {recentLeads.length === 0 ? (
                      <p className="text-sm text-slate-400">No leads yet.</p>
                    ) : (
                      <ul className="divide-y divide-slate-800">
                        {recentLeads.map((l) => (
                          <li key={l.id} className="py-2.5 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <Link
                                href={`/leads/${l.id}`}
                                className="text-sm font-medium text-orange-400 hover:underline"
                              >
                                {l.name}
                              </Link>
                              <p className="text-xs text-slate-400">
                                {l.product ? `${l.product.name}${l.color ? ` (${l.color})` : ""} · ` : ""}
                                {l.source} · {formatDate(l.createdAt)}
                              </p>
                            </div>
                            <span className="badge text-white" style={{ backgroundColor: l.stage.color }}>
                              {l.status === "open" ? l.stage.name : l.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="card">
                    <h2 className="font-semibold mb-4">Recent communications</h2>
                    {recentComms.length === 0 ? (
                      <p className="text-sm text-slate-400">Nothing logged yet.</p>
                    ) : (
                      <ul className="divide-y divide-slate-800">
                        {recentComms.map((c) => (
                          <li key={c.id} className="py-2.5">
                            <p className="text-sm">
                              <span className="font-medium capitalize">{c.type}</span>
                              {" — "}
                              {c.contact ? (
                                <Link
                                  href={`/contacts/${c.contact.id}`}
                                  className="text-orange-400 hover:underline"
                                >
                                  {contactName(c.contact)}
                                </Link>
                              ) : c.lead ? (
                                <Link
                                  href={`/leads/${c.lead.id}`}
                                  className="text-orange-400 hover:underline"
                                >
                                  {c.lead.name}
                                </Link>
                              ) : (
                                "—"
                              )}
                            </p>
                            <p className="text-xs text-slate-400 truncate">
                              {c.body} · {formatDateTime(c.occurredAt)} · {c.user.name}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            ),
          },
          {
            key: "service",
            label: "Service",
            count: dueVehicles.length + openJobCards,
            content: (
              <>
                <StatCards
                  stats={[
                    { label: "Open job cards", value: String(openJobCards), href: "/jobcards" },
                    { label: "Service due", value: String(dueVehicles.length), href: "/vehicles" },
                    {
                      label: "Vehicles on record",
                      value: String(vehicles.length),
                      href: "/vehicles",
                    },
                    { label: "Workshop calendar", value: "→", href: "/workshop-calendar" },
                  ]}
                />
                <div className="card mt-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-semibold">Vehicles due for service</h2>
                    <Link href="/vehicles" className="text-sm text-orange-400 hover:underline">
                      All vehicles →
                    </Link>
                  </div>
                  {dueVehicles.length === 0 ? (
                    <p className="text-sm text-slate-400">Nothing due. 🎉</p>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {dueVehicles.slice(0, 10).map(({ vehicle, due }) => (
                        <li key={vehicle.id} className="py-2.5 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <Link
                              href={`/vehicles/${vehicle.id}`}
                              className="text-sm font-medium text-orange-400 hover:underline"
                            >
                              {vehicle.model}
                            </Link>
                            <p className="text-xs text-slate-400">
                              {contactName(vehicle.contact)}
                              {due.nextDueDate ? ` · due ${formatDate(due.nextDueDate)}` : ""}
                              {due.nextDueKm != null
                                ? ` · at ${due.nextDueKm.toLocaleString()} km`
                                : ""}
                            </p>
                          </div>
                          <span className={`badge ${dueColors[due.status]}`}>
                            {dueLabels[due.status]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
