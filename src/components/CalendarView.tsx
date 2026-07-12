import Link from "next/link";
import {
  addMonths,
  addDays,
  format,
  isSameDay,
  isSameMonth,
  parse,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import CalendarEventChip, { type CalendarEvent } from "@/components/CalendarEventChip";

export default async function CalendarView({
  mode,
  m,
  activityIds,
}: {
  mode: "sales" | "workshop";
  m?: string;
  activityIds: string[] | null;
}) {
  const month = m ? parse(m, "yyyy-MM", new Date()) : new Date();
  const monthStart = startOfMonth(month);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = addDays(gridStart, 42);
  const basePath = mode === "workshop" ? "/workshop-calendar" : "/calendar";

  const activities = await prisma.activity.findMany({
    where: {
      dueDate: { gte: gridStart, lt: gridEnd },
      status: { in: ["planned", "done"] },
      ...(activityIds === null ? {} : { id: { in: activityIds } }),
      ...(mode === "workshop"
        ? { category: "workshop" }
        : { OR: [{ category: null }, { category: { not: "workshop" } }] }),
    },
    include: { assignedTo: true, lead: true, contact: true },
    orderBy: { dueDate: "asc" },
  });

  const todayStart = startOfDay(new Date());
  const events: (CalendarEvent & { dueDate: Date })[] = activities.map((activity) => {
    const time = format(activity.dueDate, "HH:mm");
    return {
      id: activity.id,
      dueDate: activity.dueDate,
      href: activity.lead ? `/leads/${activity.lead.id}` : activity.contact ? `/contacts/${activity.contact.id}` : "/activities",
      summary: activity.summary,
      time: time === "00:00" ? null : time,
      status: activity.status,
      overdue: activity.status === "planned" && activity.dueDate < todayStart,
      type: activity.type,
      workshop: activity.category === "workshop",
      who: activity.lead ? activity.lead.name : activity.contact ? contactName(activity.contact) : null,
      phone: activity.contact?.phone ?? activity.lead?.phone ?? null,
      email: activity.contact?.email ?? activity.lead?.email ?? null,
      assignee: activity.assignedTo.name,
      location: activity.location,
      note: activity.note,
      dateLabel: format(activity.dueDate, "EEE d MMM"),
    };
  });

  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const today = new Date();
  const prev = format(addMonths(monthStart, -1), "yyyy-MM");
  const next = format(addMonths(monthStart, 1), "yyyy-MM");

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${mode === "workshop" ? "Workshop" : "Sales"} calendar — ${format(monthStart, "MMMM yyyy")}`}
        description={
          mode === "workshop"
            ? "Accessible service bookings and workshop jobs. Completed items stay for reference."
            : "Accessible demos, calls, meetings and test drives. Completed items stay for reference."
        }
      >
        <div className="flex overflow-hidden rounded-lg border border-border">
          <Link
            href="/calendar"
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              mode === "sales"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            Sales
          </Link>
          <Link
            href="/workshop-calendar"
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              mode === "workshop"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            Workshop
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <Button asChild variant="outline" size="sm">
            <Link href={`${basePath}?m=${prev}`} aria-label="Previous month"><ChevronLeft className="size-4" /></Link>
          </Button>
          <Button asChild variant="outline" size="sm"><Link href={basePath}>Today</Link></Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`${basePath}?m=${next}`} aria-label="Next month"><ChevronRight className="size-4" /></Link>
          </Button>
        </div>
      </PageHeader>

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <div className="min-w-[700px]">
          <div className="grid grid-cols-7 border-b border-border">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
              <div key={day} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{day}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const dayEvents = events.filter((event) => isSameDay(event.dueDate, day));
              const inMonth = isSameMonth(day, monthStart);
              const isToday = isSameDay(day, today);
              return (
                <div key={day.toISOString()} className={cn("min-h-24 border-b border-r border-border/50 p-1.5", !inMonth && "bg-background/60")}>
                  <p className={cn("mb-1 text-xs", isToday ? "inline-flex size-5 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground" : inMonth ? "font-medium text-foreground/80" : "text-muted-foreground/50")}>{format(day, "d")}</p>
                  <div className="space-y-1">
                    {dayEvents.slice(0, 4).map((event) => <CalendarEventChip key={event.id} event={event} />)}
                    {dayEvents.length > 4 && <p className="px-1 text-[10px] text-muted-foreground/70">+{dayEvents.length - 4} more</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
