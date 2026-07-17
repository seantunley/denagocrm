"use client";

import {
  useMemo,
  useState,
  useTransition,
  type ComponentType,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarPlus,
  Car,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock4,
  FilterX,
  List,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Search,
  StickyNote,
  User,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  cancelActivity,
  completeActivity,
  rescheduleActivity,
} from "@/app/actions/activities";
import { PageHeader } from "@/components/page-header";
import { openQuickCreate } from "@/components/QuickCreateDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shiftDateKey } from "@/lib/calendarDates";
import { cn } from "@/lib/utils";

export type CalendarWorkspaceEvent = {
  id: string;
  dueDate: string;
  dateKey: string;
  href: string;
  summary: string;
  time: string | null;
  status: string;
  overdue: boolean;
  type: string;
  workshop: boolean;
  who: string | null;
  context: string | null;
  phone: string | null;
  email: string | null;
  assignee: string;
  location: string | null;
  note: string | null;
  dateLabel: string;
};

type CalendarDay = {
  key: string;
  dayNumber: string;
  weekday: string;
  label: string;
  inMonth: boolean;
};

type SlotConfig = {
  times: string[];
  days: number[];
  capacity: number;
  horizonDays: number;
};

type CalendarViewMode = "month" | "week" | "agenda";

const EVENT_TYPES: Record<
  string,
  {
    label: string;
    icon: ComponentType<{ className?: string }>;
    tone: string;
    dot: string;
  }
> = {
  call: {
    label: "Call",
    icon: Phone,
    tone: "border-sky-500/25 bg-sky-500/10 text-sky-200",
    dot: "bg-sky-400",
  },
  email: {
    label: "Email",
    icon: Mail,
    tone: "border-indigo-500/25 bg-indigo-500/10 text-indigo-200",
    dot: "bg-indigo-400",
  },
  whatsapp: {
    label: "WhatsApp",
    icon: MessageCircle,
    tone: "border-emerald-500/25 bg-emerald-500/10 text-emerald-200",
    dot: "bg-emerald-400",
  },
  meeting: {
    label: "Meeting",
    icon: Users,
    tone: "border-orange-500/25 bg-orange-500/10 text-orange-200",
    dot: "bg-orange-400",
  },
  test_drive: {
    label: "Test drive",
    icon: Car,
    tone: "border-orange-500/25 bg-orange-500/10 text-orange-200",
    dot: "bg-orange-400",
  },
  todo: {
    label: "To-do",
    icon: CheckCircle2,
    tone: "border-slate-500/25 bg-slate-500/10 text-slate-200",
    dot: "bg-slate-400",
  },
};

const DEFAULT_EVENT_TYPE = {
  label: "Activity",
  icon: CalendarDays,
  tone: "border-slate-500/25 bg-slate-500/10 text-slate-200",
  dot: "bg-slate-400",
};

function eventType(type: string) {
  return EVENT_TYPES[type] ?? DEFAULT_EVENT_TYPE;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function localDateTimeValue(event: CalendarWorkspaceEvent) {
  if (!event.time) return `${event.dateKey}T09:00`;
  return `${event.dateKey}T${event.time}`;
}

function isoWeekday(dateKey: string) {
  const weekday = new Date(`${dateKey}T12:00:00`).getDay();
  return weekday === 0 ? 7 : weekday;
}

function EventCard({
  event,
  compact = false,
  canManage,
  onOpen,
  onDragStart,
}: {
  event: CalendarWorkspaceEvent;
  compact?: boolean;
  canManage: boolean;
  onOpen: (event: CalendarWorkspaceEvent) => void;
  onDragStart: (eventId: string) => void;
}) {
  const config = eventType(event.type);
  const Icon = event.workshop ? Wrench : config.icon;
  const done = event.status === "done";

  return (
    <Tooltip delayDuration={180}>
      <TooltipTrigger asChild>
        <button
          type="button"
          draggable={canManage && !done}
          onDragStart={(dragEvent) => {
            dragEvent.dataTransfer.effectAllowed = "move";
            dragEvent.dataTransfer.setData("text/calendar-event", event.id);
            onDragStart(event.id);
          }}
          onClick={() => onOpen(event)}
          className={cn(
            "group/event w-full overflow-hidden rounded-lg border text-left transition hover:-translate-y-px hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            done
              ? "border-border bg-muted/45 text-muted-foreground"
              : event.overdue
                ? "border-red-500/30 bg-red-500/10 text-red-100"
                : event.workshop
                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-100"
                  : config.tone,
            compact ? "px-2 py-1.5" : "p-3",
            canManage && !done && "cursor-grab active:cursor-grabbing",
          )}
          aria-label={`${event.summary}, ${event.dateLabel}${event.time ? ` at ${event.time}` : ""}`}
        >
          <div className="flex min-w-0 items-start gap-2">
            <Icon className={cn("mt-0.5 shrink-0", compact ? "size-3" : "size-4")} />
            <div className="min-w-0 flex-1">
              <p className={cn("truncate font-medium", compact ? "text-[11px] leading-4" : "text-sm", done && "line-through")}>
                {event.time && <span className="mr-1.5 tabular-nums opacity-75">{event.time}</span>}
                {event.summary}
              </p>
              {!compact && (
                <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] opacity-70">
                  <span className="truncate">{event.who ?? eventType(event.type).label}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{event.assignee}</span>
                </div>
              )}
            </div>
            {done && <Check className="size-3.5 shrink-0" />}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="hidden w-80 max-w-[calc(100vw-2rem)] border-border p-0 shadow-2xl lg:block">
        <div className="overflow-hidden rounded-lg">
          <div className="border-b border-border bg-card/95 p-3.5">
            <div className="flex items-start gap-2.5">
              <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border", event.workshop ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200" : config.tone)}>
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-5 text-popover-foreground">{event.summary}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{event.dateLabel}{event.time ? ` · ${event.time}` : " · All day"}</span>
                  <span className={cn(
                    "rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide",
                    done
                      ? "bg-emerald-500/15 text-emerald-300"
                      : event.overdue
                        ? "bg-red-500/15 text-red-300"
                        : "bg-muted text-muted-foreground",
                  )}>
                    {done ? "Completed" : event.overdue ? "Overdue" : "Planned"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2 bg-popover p-3.5 text-[11px] text-muted-foreground">
            {event.who && (
              <p className="flex items-center gap-2">
                <User className="size-3.5 shrink-0 text-primary" />
                <span className="truncate font-medium text-popover-foreground">{event.who}</span>
              </p>
            )}
            {event.context && (
              <p className="flex items-center gap-2">
                <Car className="size-3.5 shrink-0" />
                <span className="truncate">{event.context}</span>
              </p>
            )}
            {event.phone && (
              <p className="flex items-center gap-2">
                <Phone className="size-3.5 shrink-0" />
                <span>{event.phone}</span>
              </p>
            )}
            {event.email && (
              <p className="flex min-w-0 items-center gap-2">
                <Mail className="size-3.5 shrink-0" />
                <span className="truncate">{event.email}</span>
              </p>
            )}
            {event.location && (
              <p className="flex items-center gap-2">
                <MapPin className="size-3.5 shrink-0" />
                <span className="truncate">{event.location}</span>
              </p>
            )}
            {event.note && (
              <p className="flex items-start gap-2 border-t border-border pt-2">
                <StickyNote className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-3 leading-5">{event.note}</span>
              </p>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
              <p className="flex min-w-0 items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">{initials(event.assignee)}</span>
                <span className="truncate">{event.assignee}</span>
              </p>
              <span className="shrink-0 font-medium text-primary">Click for details</span>
            </div>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export default function CalendarWorkspace({
  mode,
  monthKey,
  monthLabel,
  previousMonth,
  nextMonth,
  todayKey,
  initialDate,
  days,
  events,
  canManage,
  slotConfig,
  bookingCountsByDate = {},
}: {
  mode: "sales" | "workshop";
  monthKey: string;
  monthLabel: string;
  previousMonth: string;
  nextMonth: string;
  todayKey: string;
  initialDate?: string;
  days: CalendarDay[];
  events: CalendarWorkspaceEvent[];
  canManage: boolean;
  slotConfig: SlotConfig | null;
  // Bookings per date from an UNFILTERED source (all technicians), so capacity maths
  // aren't undercounted for RBAC-scoped users who can't see every booking.
  bookingCountsByDate?: Record<string, number>;
}) {
  const router = useRouter();
  const basePath =
    mode === "workshop" ? "/workshop-calendar" : "/calendar";
  const [view, setView] = useState<CalendarViewMode>("month");
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [type, setType] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => {
    if (initialDate && days.some((day) => day.key === initialDate)) {
      return initialDate;
    }
    if (days.some((day) => day.key === todayKey && day.inMonth)) {
      return todayKey;
    }
    return days.find((day) => day.inMonth)?.key ?? days[0]?.key ?? todayKey;
  });
  const [selectedEvent, setSelectedEvent] =
    useState<CalendarWorkspaceEvent | null>(null);
  const [dayDialog, setDayDialog] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState("");
  const [isPending, startTransition] = useTransition();

  const owners = useMemo(
    () =>
      Array.from(new Set(events.map((event) => event.assignee))).sort(),
    [events],
  );
  const types = useMemo(
    () => Array.from(new Set(events.map((event) => event.type))).sort(),
    [events],
  );

  const visibleEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      const matchesQuery =
        !needle ||
        [
          event.summary,
          event.who,
          event.context,
          event.assignee,
          event.location,
          eventType(event.type).label,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return (
        matchesQuery &&
        (!owner || event.assignee === owner) &&
        (!type || event.type === type) &&
        (!attentionOnly || event.overdue)
      );
    });
  }, [attentionOnly, events, owner, query, type]);

  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, CalendarWorkspaceEvent[]>();
    for (const event of visibleEvents) {
      const existing = grouped.get(event.dateKey) ?? [];
      existing.push(event);
      grouped.set(event.dateKey, existing);
    }
    return grouped;
  }, [visibleEvents]);


  const selectedIndex = Math.max(
    0,
    days.findIndex((day) => day.key === selectedDate),
  );
  const weekStartIndex = Math.floor(selectedIndex / 7) * 7;
  const weekDays = days.slice(weekStartIndex, weekStartIndex + 7);
  const monthDays = days.filter((day) => day.inMonth);
  const agendaDays = days.filter(
    (day) =>
      day.inMonth && (eventsByDate.get(day.key)?.length ?? 0) > 0,
  );
  const filtersActive = Boolean(query || owner || type || attentionOnly);
  const periodLabel =
    view === "week" && weekDays.length > 0
      ? `${weekDays[0].label} – ${weekDays.at(-1)?.label ?? weekDays[0].label}`
      : monthLabel;

  const stats = useMemo(() => {
    const inMonthKeys = new Set(
      days.filter((day) => day.inMonth).map((day) => day.key),
    );
    const monthEvents = events.filter((event) =>
      inMonthKeys.has(event.dateKey),
    );
    // Only dates the public booking engine actually offers contribute open capacity:
    // a configured weekday, not in the past, and within the booking horizon.
    const horizonMax = slotConfig
      ? shiftDateKey(todayKey, slotConfig.horizonDays)
      : todayKey;
    const openSlots = slotConfig
      ? days
          .filter(
            (day) =>
              day.inMonth &&
              slotConfig.days.includes(isoWeekday(day.key)) &&
              day.key >= todayKey &&
              day.key <= horizonMax,
          )
          .reduce((total, day) => {
            const capacity =
              slotConfig.times.length * slotConfig.capacity;
            // Unfiltered booking count so hidden bookings still consume capacity.
            const booked = bookingCountsByDate[day.key] ?? 0;
            return total + Math.max(0, capacity - booked);
          }, 0)
      : 0;

    return {
      today: monthEvents.filter(
        (event) =>
          event.dateKey === todayKey && event.status === "planned",
      ).length,
      overdue: monthEvents.filter((event) => event.overdue).length,
      featured:
        mode === "workshop"
          ? monthEvents.filter((event) => event.status === "planned").length
          : monthEvents.filter(
              (event) =>
                event.type === "test_drive" &&
                event.status === "planned",
            ).length,
      completed: monthEvents.filter((event) => event.status === "done")
        .length,
      openSlots,
    };
  }, [bookingCountsByDate, days, events, mode, slotConfig, todayKey]);

  function openEvent(event: CalendarWorkspaceEvent) {
    setSelectedEvent(event);
    setRescheduleValue(localDateTimeValue(event));
  }

  function createActivity(dateKey = selectedDate) {
    // Workshop bookings must land on a real configured slot, otherwise the booking
    // engine won't mark any public slot taken and the day can be double-booked.
    const defaultTime =
      mode === "workshop" && slotConfig?.times.length
        ? slotConfig.times[0]
        : "09:00";
    openQuickCreate("calendar", {
      dueDate: `${dateKey}T${defaultTime}`,
      workshop: mode === "workshop",
      revalidate: basePath,
    });
  }

  function runAction(
    action: () => Promise<unknown>,
    success: string,
  ) {
    startTransition(async () => {
      try {
        await action();
        toast.success(success);
        setSelectedEvent(null);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Calendar action failed",
        );
      }
    });
  }

  function completeSelected() {
    if (!selectedEvent) return;
    const data = new FormData();
    data.set("revalidate", basePath);
    runAction(
      () => completeActivity(selectedEvent.id, data),
      "Activity completed",
    );
  }

  function cancelSelected() {
    if (!selectedEvent) return;
    runAction(
      () => cancelActivity(selectedEvent.id, basePath),
      "Activity cancelled",
    );
  }

  function rescheduleSelected() {
    if (!selectedEvent || !rescheduleValue) return;
    runAction(async () => {
      const result = await rescheduleActivity(
        selectedEvent.id,
        rescheduleValue,
      );
      if (!result.ok) {
        throw new Error(
          result.error ?? "Could not reschedule activity",
        );
      }
    }, "Activity rescheduled");
  }

  function dropOnDate(dateKey: string, transferredId?: string) {
    const eventId = transferredId || draggingId;
    setDraggingId(null);
    if (!eventId) return;
    const event = events.find((item) => item.id === eventId);
    if (!event || event.dateKey === dateKey) return;
    const when = event.time ? `${dateKey}T${event.time}` : dateKey;
    runAction(async () => {
      const result = await rescheduleActivity(event.id, when);
      if (!result.ok) {
        throw new Error(
          result.error ?? "Could not reschedule activity",
        );
      }
    }, `${event.summary} moved to ${dateKey}`);
  }

  function navigateWeek(direction: -1 | 1) {
    const currentWeekStart = weekDays[0]?.key ?? selectedDate;
    const targetDate = shiftDateKey(currentWeekStart, direction * 7);
    if (days.some((day) => day.key === targetDate)) {
      setSelectedDate(targetDate);
      return;
    }
    router.push(
      `${basePath}?m=${targetDate.slice(0, 7)}&d=${targetDate}`,
    );
  }

  function dayCapacity(dateKey: string) {
    if (
      !slotConfig ||
      !slotConfig.days.includes(isoWeekday(dateKey))
    ) {
      return null;
    }
    const capacity = slotConfig.times.length * slotConfig.capacity;
    // Unfiltered booking count so a slot taken by another (hidden) technician still
    // shows as occupied capacity for RBAC-scoped users.
    const booked = bookingCountsByDate[dateKey] ?? 0;
    return {
      capacity,
      booked,
      percentage: Math.min(
        100,
        capacity ? (booked / capacity) * 100 : 0,
      ),
    };
  }

  const statCards =
    mode === "workshop"
      ? [
          {
            label: "Today",
            value: stats.today,
            detail: "planned jobs",
            icon: CalendarDays,
            tone: "text-primary",
          },
          {
            label: "Bookings",
            value: stats.featured,
            detail: "this month",
            icon: Wrench,
            tone: "text-emerald-300",
          },
          {
            label: "Open slots",
            value: stats.openSlots,
            detail: "configured capacity",
            icon: Clock4,
            tone: "text-sky-300",
          },
          {
            label: "Overdue",
            value: stats.overdue,
            detail: "need attention",
            icon: CircleAlert,
            tone: "text-red-300",
          },
        ]
      : [
          {
            label: "Today",
            value: stats.today,
            detail: "planned activities",
            icon: CalendarDays,
            tone: "text-primary",
          },
          {
            label: "Test drives",
            value: stats.featured,
            detail: "this month",
            icon: Car,
            tone: "text-orange-300",
          },
          {
            label: "Completed",
            value: stats.completed,
            detail: "this month",
            icon: CheckCircle2,
            tone: "text-emerald-300",
          },
          {
            label: "Overdue",
            value: stats.overdue,
            detail: "need attention",
            icon: CircleAlert,
            tone: "text-red-300",
          },
        ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${mode === "workshop" ? "Workshop" : "Sales"} calendar`}
        description={
          mode === "workshop"
            ? "Plan service capacity, workshop bookings and the team responsible."
            : "Coordinate customer follow-ups, meetings and test drives."
        }
      >
        <div className="flex overflow-hidden rounded-lg border border-border bg-card/60">
          <Link
            href={`/calendar?m=${monthKey}`}
            className={cn(
              "px-3 py-2 text-xs font-semibold",
              mode === "sales"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            Sales
          </Link>
          <Link
            href={`/workshop-calendar?m=${monthKey}`}
            className={cn(
              "px-3 py-2 text-xs font-semibold",
              mode === "workshop"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            Workshop
          </Link>
        </div>
        {canManage && (
          <Button type="button" onClick={() => createActivity()}>
            <CalendarPlus className="size-4" />
            Schedule
          </Button>
        )}
      </PageHeader>

      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border bg-card/65 p-3.5 shadow-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {stat.label}
              </p>
              <stat.icon className={cn("size-4", stat.tone)} />
            </div>
            <div className="mt-2 flex items-end gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {stat.value}
              </span>
              <span className="pb-0.5 text-[10px] text-muted-foreground">
                {stat.detail}
              </span>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-border bg-card/65 p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
            <label className="relative min-w-0 flex-1 xl:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="input h-10 pl-9"
                placeholder="Search customer, activity, owner…"
                aria-label="Search calendar"
              />
            </label>
            <select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="input h-10 sm:w-40"
              aria-label="Filter by owner"
            >
              <option value="">All owners</option>
              {owners.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="input h-10 sm:w-40"
              aria-label="Filter by activity type"
            >
              <option value="">All activity types</option>
              {types.map((value) => (
                <option key={value} value={value}>
                  {eventType(value).label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() =>
                setAttentionOnly((current) => !current)
              }
              className={cn(
                "btn-secondary h-10",
                attentionOnly &&
                  "border-red-400/35 bg-red-500/10 text-red-200",
              )}
              aria-pressed={attentionOnly}
            >
              <CircleAlert className="size-4" />
              Overdue
            </button>
            {filtersActive && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setOwner("");
                  setType("");
                  setAttentionOnly(false);
                }}
                className="btn h-10 text-muted-foreground"
              >
                <FilterX className="size-4" />
                Clear
              </button>
            )}
          </div>

          <div
            className="hidden items-center gap-1 rounded-lg border border-border bg-background/40 p-1 lg:flex"
            aria-label="Calendar view"
          >
            {(
              [
                ["month", CalendarDays, "Month"],
                ["week", Users, "Week"],
                ["agenda", List, "Agenda"],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setView(value)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition",
                  view === value &&
                    "bg-primary text-primary-foreground shadow-sm",
                )}
                aria-pressed={view === value}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
          <div>
            <p className="text-lg font-semibold tracking-tight text-foreground">
              {periodLabel}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {visibleEvents.length}
              {visibleEvents.length !== events.length
                ? ` of ${events.length}`
                : ""}{" "}
              visible activities
            </p>
          </div>
          <div className="flex items-center gap-1">
            {view === "week" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() => navigateWeek(-1)}
                  aria-label="Previous week"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={basePath}>Today</Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() => navigateWeek(1)}
                  aria-label="Next week"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant="outline" size="icon-sm">
                  <Link
                    href={`${basePath}?m=${previousMonth}`}
                    aria-label="Previous month"
                  >
                    <ChevronLeft className="size-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={basePath}>Today</Link>
                </Button>
                <Button asChild variant="outline" size="icon-sm">
                  <Link
                    href={`${basePath}?m=${nextMonth}`}
                    aria-label="Next month"
                  >
                    <ChevronRight className="size-4" />
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="lg:hidden">
        <div className="sticky top-14 z-20 -mx-1 overflow-x-auto border-y border-border bg-background/95 px-1 py-3 backdrop-blur">
          <div className="flex min-w-max gap-2">
            {monthDays.map((day) => {
              const count = eventsByDate.get(day.key)?.length ?? 0;
              return (
                <button
                  key={day.key}
                  type="button"
                  onClick={() => setSelectedDate(day.key)}
                  className={cn(
                    "relative flex w-14 flex-col items-center rounded-xl border px-2 py-2 text-xs transition",
                    selectedDate === day.key
                      ? "border-primary bg-primary text-primary-foreground shadow-sm"
                      : "border-border bg-card text-muted-foreground",
                  )}
                >
                  <span className="text-[9px] font-semibold uppercase tracking-wider">
                    {day.weekday}
                  </span>
                  <span className="mt-1 text-lg font-semibold tabular-nums">
                    {day.dayNumber}
                  </span>
                  {count > 0 && (
                    <span
                      className={cn(
                        "absolute bottom-1 size-1 rounded-full",
                        selectedDate === day.key
                          ? "bg-primary-foreground"
                          : "bg-primary",
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-border bg-card/45 p-3">
          <div className="flex items-center justify-between gap-3 px-1 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {
                  days.find((day) => day.key === selectedDate)
                    ?.label
                }
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {eventsByDate.get(selectedDate)?.length ?? 0} scheduled
              </p>
            </div>
            {canManage && (
              <Button
                type="button"
                size="sm"
                onClick={() => createActivity(selectedDate)}
              >
                <CalendarPlus className="size-4" />
                Add
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {(eventsByDate.get(selectedDate) ?? []).map((event) => (
              <EventCard
                key={event.id}
                event={event}
                canManage={canManage}
                onOpen={openEvent}
                onDragStart={setDraggingId}
              />
            ))}
            {(eventsByDate.get(selectedDate)?.length ?? 0) === 0 && (
              <button
                type="button"
                onClick={() =>
                  canManage && createActivity(selectedDate)
                }
                className="flex min-h-36 w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/25 px-6 text-center"
              >
                <CalendarPlus className="size-5 text-muted-foreground" />
                <span className="mt-3 text-sm font-medium text-foreground">
                  Nothing scheduled
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                  {canManage
                    ? "Tap to add an activity for this day."
                    : "No accessible activities for this day."}
                </span>
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="hidden lg:block">
        {view === "month" && (
          <div className="overflow-hidden rounded-2xl border border-border bg-card/45 shadow-sm">
            <div className="grid grid-cols-7 border-b border-border bg-card/85">
              {[
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
              ].map((weekday) => (
                <div
                  key={weekday}
                  className="px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                >
                  {weekday.slice(0, 3)}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((day) => {
                const dayEvents = eventsByDate.get(day.key) ?? [];
                const capacity =
                  mode === "workshop"
                    ? dayCapacity(day.key)
                    : null;
                return (
                  <div
                    key={day.key}
                    onDragOver={(event) => {
                      if (canManage) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      dropOnDate(
                        day.key,
                        event.dataTransfer.getData(
                          "text/calendar-event",
                        ),
                      );
                    }}
                    className={cn(
                      "group/day relative min-h-36 border-b border-r border-border/60 p-2 transition",
                      !day.inMonth &&
                        "bg-background/55 opacity-55",
                      draggingId && "hover:bg-primary/[0.07]",
                    )}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "grid size-6 place-items-center rounded-full text-xs font-semibold tabular-nums",
                          day.key === todayKey
                            ? "bg-primary text-primary-foreground"
                            : "text-foreground",
                        )}
                      >
                        {day.dayNumber}
                      </span>
                      {canManage && day.inMonth && (
                        <button
                          type="button"
                          onClick={() => createActivity(day.key)}
                          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover/day:opacity-100 focus:opacity-100"
                          aria-label={`Schedule activity on ${day.label}`}
                        >
                          <CalendarPlus className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {capacity && (
                      <div
                        className="mb-2"
                        title={`${capacity.booked} of ${capacity.capacity} workshop slots used`}
                      >
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              capacity.percentage >= 100
                                ? "bg-red-400"
                                : capacity.percentage >= 70
                                  ? "bg-amber-400"
                                  : "bg-emerald-400",
                            )}
                            style={{
                              width: `${capacity.percentage}%`,
                            }}
                          />
                        </div>
                        <p className="mt-1 text-[9px] text-muted-foreground">
                          {capacity.booked}/{capacity.capacity} slots
                        </p>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {dayEvents.slice(0, 3).map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          compact
                          canManage={canManage}
                          onOpen={openEvent}
                          onDragStart={setDraggingId}
                        />
                      ))}
                      {dayEvents.length > 3 && (
                        <button
                          type="button"
                          onClick={() => setDayDialog(day.key)}
                          className="w-full rounded-md px-2 py-1 text-left text-[10px] font-medium text-primary hover:bg-primary/10"
                        >
                          +{dayEvents.length - 3} more
                        </button>
                      )}
                      {dayEvents.length === 0 &&
                        canManage &&
                        day.inMonth && (
                          <button
                            type="button"
                            onClick={() => createActivity(day.key)}
                            className="hidden w-full rounded-lg border border-dashed border-border/60 py-3 text-[10px] text-muted-foreground group-hover/day:block"
                          >
                            Add activity
                          </button>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === "week" && (
          <div
            className="overflow-x-auto rounded-2xl border border-border bg-card/45 shadow-sm"
            onDragEnd={() => setDraggingId(null)}
          >
            <div className="flex min-w-[1050px]">
              {weekDays.map((day) => {
                const dayEvents = eventsByDate.get(day.key) ?? [];
                return (
                  <div
                    key={day.key}
                    onDragOver={(event) => {
                      if (canManage) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      dropOnDate(
                        day.key,
                        event.dataTransfer.getData(
                          "text/calendar-event",
                        ),
                      );
                    }}
                    className="min-h-[32rem] flex-1 border-r border-border/70 p-2.5 last:border-r-0"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedDate(day.key)}
                      className="mb-3 flex w-full items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-left hover:border-primary/30"
                    >
                      <span>
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {day.weekday}
                        </span>
                        <span className="text-sm font-semibold text-foreground">
                          {day.dayNumber}
                        </span>
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                        {dayEvents.length}
                      </span>
                    </button>
                    <div className="space-y-2">
                      {dayEvents.map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          canManage={canManage}
                          onOpen={openEvent}
                          onDragStart={setDraggingId}
                        />
                      ))}
                      {dayEvents.length === 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            canManage &&
                            createActivity(day.key)
                          }
                          className="flex min-h-28 w-full items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground"
                        >
                          {canManage
                            ? "Schedule activity"
                            : "No activities"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === "agenda" && (
          <div className="overflow-hidden rounded-2xl border border-border bg-card/45 shadow-sm">
            {agendaDays.length > 0 ? (
              agendaDays.map((day) => {
                const dayEvents = eventsByDate.get(day.key) ?? [];
                return (
                  <div
                    key={day.key}
                    className="grid border-b border-border/70 last:border-b-0 lg:grid-cols-[11rem_1fr]"
                  >
                    <div className="border-r border-border/70 bg-card/45 p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {day.weekday}
                      </p>
                      <p className="mt-1 text-base font-semibold text-foreground">
                        {day.dayNumber}{" "}
                        {monthLabel.split(" ")[0]}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {dayEvents.length} scheduled
                      </p>
                    </div>
                    <div className="grid gap-2 p-3 xl:grid-cols-2">
                      {dayEvents.map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          canManage={canManage}
                          onOpen={openEvent}
                          onDragStart={setDraggingId}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
                <CalendarDays className="size-7 text-muted-foreground" />
                <h2 className="mt-4 text-base font-semibold text-foreground">
                  No activities match these filters
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Clear the filters or schedule the next activity.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(dayDialog)}
        onOpenChange={(open) => !open && setDayDialog(null)}
      >
        <ResponsiveDialogContent className="sm:max-w-xl">
          <DialogHeader className="text-left">
            <DialogTitle>
              {days.find((day) => day.key === dayDialog)?.label}
            </DialogTitle>
            <DialogDescription>
              All scheduled activity for this day.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {(eventsByDate.get(dayDialog ?? "") ?? []).map((event) => (
              <EventCard
                key={event.id}
                event={event}
                canManage={canManage}
                onOpen={(item) => {
                  setDayDialog(null);
                  openEvent(item);
                }}
                onDragStart={setDraggingId}
              />
            ))}
          </div>
        </ResponsiveDialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedEvent)}
        onOpenChange={(open) =>
          !open && setSelectedEvent(null)
        }
      >
        <ResponsiveDialogContent className="sm:max-w-xl">
          {selectedEvent && (
            <>
              <DialogHeader className="pr-10 text-left">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold",
                      selectedEvent.overdue
                        ? "border-red-500/30 bg-red-500/10 text-red-200"
                        : selectedEvent.status === "done"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                          : eventType(selectedEvent.type).tone,
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        selectedEvent.overdue
                          ? "bg-red-400"
                          : selectedEvent.status === "done"
                            ? "bg-emerald-400"
                            : eventType(selectedEvent.type).dot,
                      )}
                    />
                    {selectedEvent.status === "done"
                      ? "Completed"
                      : selectedEvent.overdue
                        ? "Overdue"
                        : eventType(selectedEvent.type).label}
                  </span>
                </div>
                <DialogTitle className="mt-2 text-xl leading-tight">
                  {selectedEvent.summary}
                </DialogTitle>
                <DialogDescription>
                  {selectedEvent.dateLabel}
                  {selectedEvent.time
                    ? ` at ${selectedEvent.time}`
                    : " · All day"}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-2 rounded-xl border border-border bg-card/55 p-3 text-sm sm:grid-cols-2">
                {selectedEvent.who && (
                  <div className="flex items-center gap-2">
                    <User className="size-4 text-muted-foreground" />
                    <span className="truncate">
                      {selectedEvent.who}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="grid size-5 place-items-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
                    {initials(selectedEvent.assignee)}
                  </span>
                  <span className="truncate">
                    {selectedEvent.assignee}
                  </span>
                </div>
                {selectedEvent.context && (
                  <div className="flex items-center gap-2">
                    <Car className="size-4 text-muted-foreground" />
                    <span className="truncate">
                      {selectedEvent.context}
                    </span>
                  </div>
                )}
                {selectedEvent.location && (
                  <div className="flex items-center gap-2">
                    <MapPin className="size-4 text-muted-foreground" />
                    <span className="truncate">
                      {selectedEvent.location}
                    </span>
                  </div>
                )}
                {selectedEvent.phone && (
                  <a
                    href={`tel:${selectedEvent.phone}`}
                    className="flex items-center gap-2 text-primary hover:underline"
                  >
                    <Phone className="size-4" />
                    {selectedEvent.phone}
                  </a>
                )}
                {selectedEvent.email && (
                  <a
                    href={`mailto:${selectedEvent.email}`}
                    className="flex min-w-0 items-center gap-2 text-primary hover:underline"
                  >
                    <Mail className="size-4 shrink-0" />
                    <span className="truncate">
                      {selectedEvent.email}
                    </span>
                  </a>
                )}
              </div>

              {selectedEvent.note && (
                <div className="flex items-start gap-2 rounded-xl border border-border bg-background/35 p-3 text-sm text-muted-foreground">
                  <StickyNote className="mt-0.5 size-4 shrink-0" />
                  <p className="leading-6">{selectedEvent.note}</p>
                </div>
              )}

              {canManage &&
                selectedEvent.status === "planned" && (
                  <div className="rounded-xl border border-border p-3">
                    <label className="label">Reschedule</label>
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="datetime-local"
                        value={rescheduleValue}
                        onChange={(event) =>
                          setRescheduleValue(event.target.value)
                        }
                        className="input flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={rescheduleSelected}
                        disabled={isPending || !rescheduleValue}
                      >
                        <Clock4 className="size-4" />
                        Move
                      </Button>
                    </div>
                  </div>
                )}

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <Button asChild variant="outline">
                  <Link href={selectedEvent.href}>Open record</Link>
                </Button>
                {canManage &&
                  selectedEvent.status === "planned" && (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={cancelSelected}
                        disabled={isPending}
                        className="text-red-300 hover:text-red-200"
                      >
                        <XCircle className="size-4" />
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        onClick={completeSelected}
                        disabled={isPending}
                      >
                        <Check className="size-4" />
                        Complete
                      </Button>
                    </div>
                  )}
              </div>
            </>
          )}
        </ResponsiveDialogContent>
      </Dialog>
    </div>
  );
}
