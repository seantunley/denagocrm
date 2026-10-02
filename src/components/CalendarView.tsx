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
import { johannesburgDateKey } from "@/lib/activityDay";
import { getSlotConfig } from "@/lib/bookingSlots";
import {
  calendarQueryBounds,
  isCalendarEventOverdue,
  shiftDateKey,
} from "@/lib/calendarDates";
import CalendarWorkspace, {
  type CalendarWorkspaceEvent,
} from "@/components/CalendarWorkspace";

function johannesburgTime(date: Date): string {
  return date.toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  });
}

function dateLabel(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00+02:00`).toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Africa/Johannesburg",
  });
}

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
  const todayKey = johannesburgDateKey(now);
  const currentMonthKey = todayKey.slice(0, 7);
  const parsedMonth = parse(
    m && /^\d{4}-\d{2}$/.test(m) ? m : currentMonthKey,
    "yyyy-MM",
    now,
  );
  const monthStart = startOfMonth(parsedMonth);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = addDays(gridStart, 42);
  const gridStartKey = format(gridStart, "yyyy-MM-dd");
  const gridEndKey = format(gridEnd, "yyyy-MM-dd");
  const lastGridKey = format(addDays(gridEnd, -1), "yyyy-MM-dd");
  const queryBounds = calendarQueryBounds(gridStartKey, gridEndKey);

  const calendarRange = {
    OR: [
      {
        availabilityBlock: false,
        dueDate: { gte: queryBounds.start, lt: queryBounds.end },
      },
      {
        availabilityBlock: true,
        dueDate: { lt: queryBounds.end },
        endDate: { gt: queryBounds.start },
      },
    ],
  };

  const calendarKind =
    mode === "workshop"
      ? { OR: [{ category: "workshop" }, { availabilityBlock: true }] }
      : {
          OR: [
            { category: null },
            { category: { not: "workshop" } },
            { availabilityBlock: true },
          ],
        };

  const [activities, slotConfig, bookingCountRows] = await Promise.all([
    prisma.activity.findMany({
      where: {
        AND: [
          calendarRange,
          calendarKind,
          { status: { in: ["planned", "done"] } },
          ...(activityIds != null ? [{ id: { in: activityIds } }] : []),
        ],
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        lead: { include: { product: { select: { name: true } } } },
        contact: true,
      },
      orderBy: { dueDate: "asc" },
    }),
    mode === "workshop" ? getSlotConfig() : Promise.resolve(null),
    mode === "workshop"
      ? prisma.activity.findMany({
          where: {
            dueDate: { gte: queryBounds.start, lt: queryBounds.end },
            status: "planned",
            category: "workshop",
          },
          select: { dueDate: true },
        })
      : Promise.resolve([] as { dueDate: Date }[]),
  ]);

  const bookingCountsByDate: Record<string, number> = {};
  for (const row of bookingCountRows) {
    const key = johannesburgDateKey(row.dueDate);
    bookingCountsByDate[key] = (bookingCountsByDate[key] ?? 0) + 1;
  }

  const events: CalendarWorkspaceEvent[] = activities.flatMap((activity) => {
    const startKey = johannesburgDateKey(activity.dueDate);
    const end = activity.endDate ?? new Date(activity.dueDate.getTime() + 60 * 60 * 1000);
    const lastInstant = new Date(Math.max(activity.dueDate.getTime(), end.getTime() - 1));
    const naturalLastKey = johannesburgDateKey(lastInstant);
    const occurrenceStart = activity.availabilityBlock && startKey < gridStartKey ? gridStartKey : startKey;
    const occurrenceEnd = activity.availabilityBlock && naturalLastKey > lastGridKey ? lastGridKey : naturalLastKey;

    const occurrenceKeys: string[] = [];
    if (activity.availabilityBlock) {
      for (let key = occurrenceStart; key <= occurrenceEnd; key = shiftDateKey(key, 1)) {
        occurrenceKeys.push(key);
      }
    } else {
      occurrenceKeys.push(startKey);
    }

    return occurrenceKeys.map((occurrenceKey, index) => {
      const dateOnly =
        activity.allDay ||
        (activity.dueDate.getUTCHours() === 0 && activity.dueDate.getUTCMinutes() === 0);
      const isNaturalStartDay = occurrenceKey === startKey;
      const isNaturalEndDay = occurrenceKey === naturalLastKey;
      const time = dateOnly || !isNaturalStartDay ? null : johannesburgTime(activity.dueDate);
      const endTime =
        activity.allDay || !isNaturalEndDay
          ? null
          : johannesburgTime(end);

      return {
        id: activity.availabilityBlock ? `${activity.id}:${occurrenceKey}` : activity.id,
        recordId: activity.id,
        dueDate: activity.dueDate.toISOString(),
        endDate: activity.endDate?.toISOString() ?? null,
        dateKey: occurrenceKey,
        href: activity.lead
          ? `/leads/${activity.lead.id}`
          : activity.contact
            ? `/contacts/${activity.contact.id}`
            : "/calendar",
        summary: activity.summary,
        time,
        endTime,
        allDay: activity.allDay,
        availabilityBlock: activity.availabilityBlock,
        status: activity.status,
        overdue: activity.availabilityBlock
          ? false
          : isCalendarEventOverdue({
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
        dateLabel: dateLabel(occurrenceKey),
        continuation: activity.availabilityBlock && index > 0,
      };
    });
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
      bookingCountsByDate={bookingCountsByDate}
    />
  );
}
