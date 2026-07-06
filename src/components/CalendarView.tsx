import Link from "next/link";
import {
  addMonths,
  addDays,
  format,
  isSameDay,
  isSameMonth,
  parse,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { prisma } from "@/lib/db";
import { activityIcons } from "@/components/ActivityPanel";
import { contactName } from "@/lib/format";

export default async function CalendarView({
  mode,
  m,
}: {
  mode: "sales" | "workshop";
  m?: string;
}) {
  const month = m ? parse(m, "yyyy-MM", new Date()) : new Date();
  const monthStart = startOfMonth(month);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = addDays(gridStart, 42);
  const basePath = mode === "workshop" ? "/workshop-calendar" : "/calendar";

  const activities = await prisma.activity.findMany({
    where: {
      dueDate: { gte: gridStart, lt: gridEnd },
      status: "planned",
      ...(mode === "workshop"
        ? { category: "workshop" }
        : { OR: [{ category: null }, { category: { not: "workshop" } }] }),
    },
    include: { assignedTo: true, lead: true, contact: true },
    orderBy: { dueDate: "asc" },
  });

  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();
  const prev = format(addMonths(monthStart, -1), "yyyy-MM");
  const next = format(addMonths(monthStart, 1), "yyyy-MM");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">
            {mode === "workshop" ? "🔧 Workshop" : "Sales"} — {format(monthStart, "MMMM yyyy")}
          </h1>
          <div className="flex gap-1">
            <Link
              href="/calendar"
              className={mode === "sales" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
            >
              Sales
            </Link>
            <Link
              href="/workshop-calendar"
              className={mode === "workshop" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
            >
              Workshop
            </Link>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`${basePath}?m=${prev}`} className="btn-secondary">
            ← {format(addMonths(monthStart, -1), "MMM")}
          </Link>
          <Link href={basePath} className="btn-secondary">
            Today
          </Link>
          <Link href={`${basePath}?m=${next}`} className="btn-secondary">
            {format(addMonths(monthStart, 1), "MMM")} →
          </Link>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-800">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 text-center"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const dayActivities = activities.filter((a) => isSameDay(a.dueDate, day));
            const inMonth = isSameMonth(day, monthStart);
            const isToday = isSameDay(day, today);
            const overdue = day < new Date(today.toDateString());
            return (
              <div
                key={day.toISOString()}
                className={`min-h-24 border-b border-r border-slate-800/60 p-1.5 ${
                  inMonth ? "" : "bg-slate-950/60"
                }`}
              >
                <p
                  className={`text-xs mb-1 ${
                    isToday
                      ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-orange-600 text-white font-bold"
                      : inMonth
                      ? "text-slate-300 font-medium"
                      : "text-slate-600"
                  }`}
                >
                  {format(day, "d")}
                </p>
                <div className="space-y-1">
                  {dayActivities.slice(0, 4).map((a) => {
                    const href = a.lead
                      ? `/leads/${a.lead.id}`
                      : a.contact
                      ? `/contacts/${a.contact.id}`
                      : "/activities";
                    const who = a.lead ? a.lead.name : a.contact ? contactName(a.contact) : "";
                    return (
                      <Link
                        key={a.id}
                        href={href}
                        title={`${a.summary}${who ? ` — ${who}` : ""} (${a.assignedTo.name})`}
                        className={`block truncate rounded px-1.5 py-0.5 text-[11px] leading-4 ${
                          overdue
                            ? "bg-red-500/15 text-red-300"
                            : a.category === "workshop"
                            ? "bg-emerald-500/15 text-emerald-200"
                            : a.type === "meeting"
                            ? "bg-orange-500/20 text-orange-200"
                            : "bg-slate-800 text-slate-300"
                        } hover:brightness-125`}
                      >
                        {activityIcons[a.type] ?? "☑️"}{" "}
                        {format(a.dueDate, "HH:mm") !== "00:00" && a.category === "workshop"
                          ? `${format(a.dueDate, "HH:mm")} `
                          : ""}
                        {a.summary}
                      </Link>
                    );
                  })}
                  {dayActivities.length > 4 && (
                    <p className="text-[10px] text-slate-500 px-1">
                      +{dayActivities.length - 4} more
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {mode === "workshop"
          ? "Service bookings from the website land here automatically (green). Schedule workshop jobs from any contact by ticking “Workshop” on the activity."
          : "Demos, calls and meetings. Workshop service bookings live on the Workshop calendar."}
      </p>
    </div>
  );
}
