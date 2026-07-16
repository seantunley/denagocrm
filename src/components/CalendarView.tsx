import {
  addDays,
  addMonths,
  format,
  isSameMonth,
  parse,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getSlotConfig } from "@/lib/bookingSlots";
import {
  calendarQueryBounds,
  isCalendarEventOverdue,
} from "@/lib/calendarDates";
import CalendarWorkspace, {
  type CalendarWorkspaceEvent,
} from "@/components/CalendarWorkspace";

export default async function CalendarView({
  mode,
  m,
  initialDate,
  activityIds,
  canManage,
}: {
  mode: "sales" | "workshop";
  m?: string;
  initialDate?: string;
  // RBAC: null = all activities accessible; otherwise restrict to these ids.
  activityIds?: string[] | null;
  canManage: boolean;
}) {
  const now = new Date();
  const todayKey = now.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Africa/Johannesburg",
  });
  const currentMonthKey = todayKey.slice(0, 7);
  const parsedMonth = parse(
    m && /^\d{4}-\d{2}$/.test(m) ? m : currentMonthKey,
    "yyyy-MM",
    now,
  );
  const monthStart = startOfMonth(parsedMonth);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = addDays(gridStart, 42);
  const queryBounds = calendarQueryBounds(
    format(gridStart, "yyyy-MM-dd"),
    format(gridEnd, "yyyy-MM-dd"),
  );

  const [activities, slotConfig] = await Promise.all([
    prisma.activity.findMany({
      where: {
        dueDate: { gte: queryBounds.start, lt: queryBounds.end },
        // History stays visible; only explicitly cancelled work is hidden.
        status: { in: ["planned", "done"] },
        ...(activityIds != null ? { id: { in: activityIds } } : {}),
        ...(mode === "workshop"
          ? { category: "workshop" }
          : { OR: [{ category: null }, { category: { not: "workshop" } }] }),
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        lead: { include: { product: { select: { name: true } } } },
        contact: true,
      },
      orderBy: { dueDate: "asc" },
    }),
    mode === "workshop" ? getSlotConfig() : Promise.resolve(null),
  ]);

  const events: CalendarWorkspaceEvent[] = activities.map((activity) => {
    // Date-only activities are stored at UTC midnight. Timed activities follow
    // the Africa/Johannesburg scheduling contract.
    const dateOnly =
      activity.dueDate.getUTCHours() === 0 &&
      activity.dueDate.getUTCMinutes() === 0;
    const time = dateOnly
      ? null
      : activity.dueDate.toLocaleTimeString("en-ZA", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Africa/Johannesburg",
        });
    const dateKey = activity.dueDate.toLocaleDateString("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Africa/Johannesburg",
    });

    return {
      id: activity.id,
      dueDate: activity.dueDate.toISOString(),
      dateKey,
      href: activity.lead
        ? `/leads/${activity.lead.id}`
        : activity.contact
          ? `/contacts/${activity.contact.id}`
          : "/activities",
      summary: activity.summary,
      time,
      status: activity.status,
      overdue: isCalendarEventOverdue({
        status: activity.status,
        dueDate: activity.dueDate,
        dateOnly,
        now,
        todayKey,
      }),
      type: activity.type,
      workshop: activity.category === "workshop",
      who: activity.lead
        ? activity.lead.name
        : activity.contact
          ? contactName(activity.contact)
          : null,
      context: activity.lead?.product?.name ?? null,
      phone: activity.contact?.phone ?? activity.lead?.phone ?? null,
      email: activity.contact?.email ?? activity.lead?.email ?? null,
      assignee: activity.assignedTo.name,
      location: activity.location,
      note: activity.note,
      dateLabel: activity.dueDate.toLocaleDateString("en-ZA", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "Africa/Johannesburg",
      }),
    };
  });

  const days = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(gridStart, index);
    return {
      key: format(date, "yyyy-MM-dd"),
      dayNumber: format(date, "d"),
      weekday: format(date, "EEE"),
      label: format(date, "EEEE, d MMMM"),
      inMonth: isSameMonth(date, monthStart),
    };
  });

  const initialDateKey =
    initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)
      ? initialDate
      : undefined;

  return (
    <CalendarWorkspace
      key={`${mode}-${format(monthStart, "yyyy-MM")}-${initialDateKey ?? ""}`}
      mode={mode}
      monthKey={format(monthStart, "yyyy-MM")}
      monthLabel={format(monthStart, "MMMM yyyy")}
      previousMonth={format(addMonths(monthStart, -1), "yyyy-MM")}
      nextMonth={format(addMonths(monthStart, 1), "yyyy-MM")}
      todayKey={todayKey}
      initialDate={initialDateKey}
      days={days}
      events={events}
      canManage={canManage}
      slotConfig={slotConfig}
    />
  );
}
