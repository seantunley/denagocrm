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
      // History stays on the calendar: completed items remain visible (✓),
      // only explicitly canceled ones are hidden.
      status: { in: ["planned", "done"] },
      ...(mode === "workshop"
        ? { category: "workshop" }
        : { OR: [{ category: null }, { category: { not: "workshop" } }] }),
    },
    include: { assignedTo: true, lead: true, contact: true },
    orderBy: { dueDate: "asc" },
  });

  const todayStart = startOfDay(new Date());
  const events: (CalendarEvent & { dueDate: Date })[] = activities.map((a) => {
    const time = format(a.dueDate, "HH:mm");
    return {
      id: a.id,
      dueDate: a.dueDate,
      href: a.lead ? `/leads/${a.lead.id}` : a.contact ? `/contacts/${a.contact.id}` : "/activities",
      summary: a.summary,
      time: time === "00:00" ? null : time,
      status: a.status,
      overdue: a.status === "planned" && a.dueDate < todayStart,
      type: a.type,
      workshop: a.category === "workshop",
      who: a.lead ? a.lead.name : a.contact ? contactName(a.contact) : null,
      phone: a.contact?.phone ?? a.lead?.phone ?? null,
      email: a.contact?.email ?? a.lead?.email ?? null,
      assignee: a.assignedTo.name,
      location: a.location,
      note: a.note,
      dateLabel: format(a.dueDate, "EEE d MMM"),
    };
  });

  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();
  const prev = format(addMonths(monthStart, -1), "yyyy-MM");
  const next = format(addMonths(monthStart, 1), "yyyy-MM");

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${mode === "workshop" ? "Workshop" : "Sales"} calendar — ${format(monthStart, "MMMM yyyy")}`}
        description={
          mode === "workshop"
            ? "Service bookings and workshop jobs. Completed items stay for reference."
            : "Demos, calls, meetings and test drives. Completed items stay for reference."
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
            <Link href={`${basePath}?m=${prev}`} aria-label="Previous month">
              <ChevronLeft className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={basePath}>Today</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`${basePath}?m=${next}`} aria-label="Next month">
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        </div>
      </PageHeader>

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <div className="min-w-[700px]">
        <div className="grid grid-cols-7 border-b border-border">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const dayEvents = events.filter((e) => isSameDay(e.dueDate, day));
            const inMonth = isSameMonth(day, monthStart);
            const isToday = isSameDay(day, today);
            return (
              <div
                key={day.toISOString()}
                className={cn(
                  "min-h-24 border-b border-r border-border/50 p-1.5",
                  !inMonth && "bg-background/60"
                )}
              >
                <p
                  className={cn(
                    "mb-1 text-xs",
                    isToday
                      ? "inline-flex size-5 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground"
                      : inMonth
                        ? "font-medium text-foreground/80"
                        : "text-muted-foreground/50"
                  )}
                >
                  {format(day, "d")}
                </p>
                <div className="space-y-1">
                  {dayEvents.slice(0, 4).map((e) => (
                    <CalendarEventChip key={e.id} event={e} />
                  ))}
                  {dayEvents.length > 4 && (
                    <p className="px-1 text-[10px] text-muted-foreground/70">
                      +{dayEvents.length - 4} more
                    </p>
                  )}
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
