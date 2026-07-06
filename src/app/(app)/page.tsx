import Link from "next/link";
import { subDays } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { runIdleAutomations } from "@/lib/automations";
import { completeActivity } from "@/app/actions/activities";
import { activityIcons } from "@/components/ActivityPanel";
import { formatZAR, formatDate, formatDateTime, contactName } from "@/lib/format";
import { computeDue, dueLabels, dueColors } from "@/lib/serviceDue";

export default async function DashboardPage() {
  const user = await requireUser();
  // Opportunistic sweep of idle-lead automation rules (also exposed as a cron endpoint)
  try {
    await runIdleAutomations();
  } catch {}
  const weekAgo = subDays(new Date(), 7);

  const [openLeads, openValue, newThisWeek, openJobCards, vehicles, recentComms, recentLeads] =
    await Promise.all([
      prisma.lead.count({ where: { status: "open" } }),
      prisma.lead.aggregate({ where: { status: "open" }, _sum: { valueCents: true } }),
      prisma.lead.count({ where: { createdAt: { gte: weekAgo } } }),
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
    ]);

  const myActivities = await prisma.activity.findMany({
    where: { status: "planned", assignedToId: user.id },
    orderBy: { dueDate: "asc" },
    include: { lead: true, contact: true },
    take: 8,
  });
  const startOfToday = new Date(new Date().toDateString());

  const dueVehicles = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((x) => x.due.status === "overdue" || x.due.status === "due_soon")
    .sort((a, b) => (a.due.status === "overdue" ? -1 : 1) - (b.due.status === "overdue" ? -1 : 1));

  const stats = [
    { label: "Open leads", value: String(openLeads), href: "/leads" },
    { label: "Pipeline value", value: formatZAR(openValue._sum.valueCents ?? 0), href: "/leads" },
    { label: "New leads (7 days)", value: String(newThisWeek), href: "/leads" },
    { label: "Open job cards", value: String(openJobCards), href: "/jobcards" },
    { label: "Service due", value: String(dueVehicles.length), href: "/vehicles" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="card hover:border-orange-600/60 transition-colors">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {s.label}
            </p>
            <p className="text-2xl font-bold mt-1">{s.value}</p>
          </Link>
        ))}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">My activities</h2>
          <Link href="/activities" className="text-sm text-orange-400 hover:underline">
            All activities →
          </Link>
        </div>
        {myActivities.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing planned for you. Schedule follow-ups from any lead or contact.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {myActivities.map((a) => {
              const overdue = a.dueDate < startOfToday;
              const endOfToday = new Date(startOfToday);
              endOfToday.setDate(endOfToday.getDate() + 1);
              const dueToday = !overdue && a.dueDate < endOfToday;
              return (
                <li key={a.id} className="py-2.5 flex items-center gap-3">
                  <span className="w-6 text-center">{activityIcons[a.type] ?? "☑️"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{a.summary}</p>
                    <p className="text-xs text-slate-400">
                      {a.lead ? (
                        <Link href={`/leads/${a.lead.id}`} className="text-orange-400 hover:underline">
                          {a.lead.name} — {a.lead.title}
                        </Link>
                      ) : a.contact ? (
                        <Link href={`/contacts/${a.contact.id}`} className="text-orange-400 hover:underline">
                          {contactName(a.contact)}
                        </Link>
                      ) : (
                        "General"
                      )}{" "}
                      ·{" "}
                      <span
                        className={
                          overdue
                            ? "text-red-400 font-semibold"
                            : dueToday
                            ? "text-amber-300 font-semibold"
                            : ""
                        }
                      >
                        {overdue ? "⚠ OVERDUE — " : dueToday ? "Due today — " : ""}
                        {formatDate(a.dueDate)}
                      </span>
                    </p>
                  </div>
                  <form action={completeActivity.bind(null, a.id)}>
                    <input type="hidden" name="revalidate" value="/" />
                    <button className="btn-secondary btn-sm">✓ Done</button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card">
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
              {dueVehicles.slice(0, 8).map(({ vehicle, due }) => (
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
                      {due.nextDueKm != null ? ` · at ${due.nextDueKm.toLocaleString()} km` : ""}
                    </p>
                  </div>
                  <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

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
                  <span
                    className="badge text-white"
                    style={{ backgroundColor: l.stage.color }}
                  >
                    {l.status === "open" ? l.stage.name : l.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
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
                    <Link href={`/contacts/${c.contact.id}`} className="text-orange-400 hover:underline">
                      {contactName(c.contact)}
                    </Link>
                  ) : c.lead ? (
                    <Link href={`/leads/${c.lead.id}`} className="text-orange-400 hover:underline">
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
  );
}
