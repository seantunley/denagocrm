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
  lead: { id: string; name: string } | null;
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
    <div className="card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-slate-800/60">
          {items.map((a) => {
            const overdue = highlightOverdue && a.dueDate < startOfToday;
            const who = a.lead ? (
              <Link href={`/leads/${a.lead.id}`} className="text-orange-400 hover:underline">
                {a.lead.name}
              </Link>
            ) : a.contact ? (
              <Link href={`/contacts/${a.contact.id}`} className="text-orange-400 hover:underline">
                {contactName(a.contact)}
              </Link>
            ) : null;
            return (
              <li key={a.id} className="py-1.5 flex items-center gap-2">
                <span className="w-5 text-center text-sm shrink-0">
                  {a.category === "workshop" ? "🔧" : activityIcons[a.type] ?? "☑️"}
                </span>
                <p className="flex-1 min-w-0 truncate text-sm">
                  {overdue && <span className="text-red-400">⚠ </span>}
                  {a.summary}
                  <span className="text-[11px] text-slate-500">
                    {" — "}
                    {who ?? "general"} · {a.assignedTo.name.split(" ")[0]}
                    {overdue && <span className="text-red-400"> · {formatDate(a.dueDate)}</span>}
                  </span>
                </p>
                <form action={completeActivity.bind(null, a.id)} className="shrink-0">
                  <input type="hidden" name="revalidate" value="/" />
                  <button
                    className="text-slate-500 hover:text-emerald-400 text-sm cursor-pointer px-1"
                    title="Mark done"
                  >
                    ✓
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatStrip({
  stats,
}: {
  stats: { label: string; value: string; href: string; icon: string }[];
}) {
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {stats.map((s) => (
        <Link
          key={s.label}
          href={s.href}
          className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 hover:border-orange-600/60 transition-colors"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-800/80 text-base">
            {s.icon}
          </span>
          <span className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 truncate">
              {s.label}
            </p>
            <p className="text-xl font-bold leading-6 truncate">{s.value}</p>
          </span>
        </Link>
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  await requireUser();
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
    todayAll,
    tomorrowAll,
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
      where: { status: "planned", dueDate: { lt: tomorrowStart } }, // incl. overdue
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
  ]);

  const salesToday = todayAll.filter((a) => a.category !== "workshop");
  const salesTomorrow = tomorrowAll.filter((a) => a.category !== "workshop");
  const shopToday = todayAll.filter((a) => a.category === "workshop");
  const shopTomorrow = tomorrowAll.filter((a) => a.category === "workshop");

  const dueVehicles = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((x) => x.due.status === "overdue" || x.due.status === "due_soon")
    .sort((a, b) => (a.due.status === "overdue" ? -1 : 1) - (b.due.status === "overdue" ? -1 : 1));

  return (
    <div className="space-y-4">
      <Tabs
        tabs={[
          {
            key: "sales",
            label: "Sales",
            count: salesToday.length,
            content: (
              <div className="space-y-4">
                <StatStrip
                  stats={[
                    { label: "Open leads", value: String(openLeads), href: "/leads", icon: "◎" },
                    {
                      label: "Pipeline",
                      value: formatZAR(openValue._sum.valueCents ?? 0),
                      href: "/leads",
                      icon: "💰",
                    },
                    { label: "New (7d)", value: String(newThisWeek), href: "/leads", icon: "✨" },
                    {
                      label: "To deliver",
                      value: String(awaitingDelivery),
                      href: "/deliveries",
                      icon: "🚚",
                    },
                  ]}
                />
                <div className="grid lg:grid-cols-2 gap-4 items-start">
                  <ActivityBlock
                    title="Today"
                    items={salesToday}
                    emptyText="Nothing due today."
                    highlightOverdue
                  />
                  <ActivityBlock
                    title="Tomorrow"
                    items={salesTomorrow}
                    emptyText="Nothing planned yet."
                  />
                </div>
                <div className="grid lg:grid-cols-2 gap-4 items-start">
                  <div className="card p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Latest leads
                      </p>
                      <Link href="/leads" className="text-xs text-orange-400 hover:underline">
                        Pipeline →
                      </Link>
                    </div>
                    <ul className="divide-y divide-slate-800/60">
                      {recentLeads.length === 0 && (
                        <li className="py-1.5 text-xs text-slate-500">No leads yet.</li>
                      )}
                      {recentLeads.map((l) => (
                        <li key={l.id} className="py-1.5 flex items-center gap-2">
                          <p className="flex-1 min-w-0 truncate text-sm">
                            <Link
                              href={`/leads/${l.id}`}
                              className="font-medium text-orange-400 hover:underline"
                            >
                              {l.name}
                            </Link>
                            <span className="text-[11px] text-slate-500">
                              {" — "}
                              {l.product ? `${l.product.name} · ` : ""}
                              {l.source} · {formatDate(l.createdAt)}
                            </span>
                          </p>
                          <span
                            className="badge text-white shrink-0"
                            style={{ backgroundColor: l.stage.color }}
                          >
                            {l.status === "open" ? l.stage.name : l.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="card p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Recent communications
                      </p>
                      <Link href="/inbox" className="text-xs text-orange-400 hover:underline">
                        Inbox →
                      </Link>
                    </div>
                    <ul className="divide-y divide-slate-800/60">
                      {recentComms.length === 0 && (
                        <li className="py-1.5 text-xs text-slate-500">Nothing logged yet.</li>
                      )}
                      {recentComms.map((c) => (
                        <li key={c.id} className="py-1.5 text-sm truncate">
                          <span className="capitalize font-medium">{c.type}</span>
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
                          <span className="text-[11px] text-slate-500">
                            {" · "}
                            {c.body.slice(0, 60)} · {formatDateTime(c.occurredAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "service",
            label: "Service",
            count: shopToday.length + dueVehicles.length,
            content: (
              <div className="space-y-4">
                <StatStrip
                  stats={[
                    {
                      label: "Open job cards",
                      value: String(openJobCards),
                      href: "/jobcards",
                      icon: "🔧",
                    },
                    {
                      label: "Service due",
                      value: String(dueVehicles.length),
                      href: "/vehicles",
                      icon: "⚠️",
                    },
                    { label: "Fleet", value: String(vehicles.length), href: "/vehicles", icon: "⚡" },
                    { label: "Workshop cal", value: "→", href: "/workshop-calendar", icon: "📅" },
                  ]}
                />
                <div className="grid lg:grid-cols-2 gap-4 items-start">
                  <ActivityBlock
                    title="Today in the workshop"
                    items={shopToday}
                    emptyText="No bookings today."
                    highlightOverdue
                  />
                  <ActivityBlock
                    title="Tomorrow in the workshop"
                    items={shopTomorrow}
                    emptyText="No bookings tomorrow."
                  />
                </div>
                <div className="card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Vehicles due for service
                    </p>
                    <Link href="/vehicles" className="text-xs text-orange-400 hover:underline">
                      All vehicles →
                    </Link>
                  </div>
                  <ul className="divide-y divide-slate-800/60">
                    {dueVehicles.length === 0 && (
                      <li className="py-1.5 text-xs text-slate-500">Nothing due. 🎉</li>
                    )}
                    {dueVehicles.slice(0, 10).map(({ vehicle, due }) => (
                      <li key={vehicle.id} className="py-1.5 flex items-center gap-2">
                        <p className="flex-1 min-w-0 truncate text-sm">
                          <Link
                            href={`/vehicles/${vehicle.id}`}
                            className="font-medium text-orange-400 hover:underline"
                          >
                            {vehicle.model}
                          </Link>
                          <span className="text-[11px] text-slate-500">
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
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
