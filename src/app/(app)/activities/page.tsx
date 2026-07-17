import Link from "next/link";
import {
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  Car,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  ListTodo,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Search,
  Trash2,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { cancelActivity, completeActivity } from "@/app/actions/activities";
import { PageHeader } from "@/components/page-header";
import { QuickCreateButton } from "@/components/QuickCreateButton";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  MetricCard,
  StatusPill,
  Surface,
} from "@/components/visual-system";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { prisma } from "@/lib/db";
import { contactName, formatDue } from "@/lib/format";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type ActivityMeta = {
  label: string;
  icon: LucideIcon;
  tone: string;
};

const ACTIVITY_TYPES: Record<string, ActivityMeta> = {
  call: { label: "Call", icon: Phone, tone: "border-sky-400/20 bg-sky-400/10 text-sky-300" },
  email: { label: "Email", icon: Mail, tone: "border-indigo-400/20 bg-indigo-400/10 text-indigo-300" },
  whatsapp: { label: "WhatsApp", icon: MessageCircle, tone: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" },
  meeting: { label: "Meeting", icon: UsersRound, tone: "border-orange-400/20 bg-orange-400/10 text-orange-300" },
  test_drive: { label: "Test drive", icon: Car, tone: "border-amber-400/20 bg-amber-400/10 text-amber-300" },
  todo: { label: "To-do", icon: ListTodo, tone: "border-slate-400/20 bg-slate-400/10 text-slate-300" },
};

const DEFAULT_ACTIVITY: ActivityMeta = {
  label: "Activity",
  icon: CalendarClock,
  tone: "border-slate-400/20 bg-slate-400/10 text-slate-300",
};

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ who?: string; q?: string; type?: string }>;
}) {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  const { who, q, type } = await searchParams;
  const mine = who !== "all";
  const [activityIds, canManage] = await Promise.all([
    getAccessibleActivityIds(user),
    hasPermission(user, "activities.manage"),
  ]);

  const plannedActivities = await prisma.activity.findMany({
    where: {
      status: "planned",
      ...(activityIds === null ? {} : { id: { in: activityIds } }),
      ...(mine ? { assignedToId: user.id } : {}),
      ...(type ? { type } : {}),
    },
    orderBy: { dueDate: "asc" },
    include: {
      assignedTo: true,
      lead: true,
      contact: true,
    },
    take: 300,
  });

  const needle = q?.trim().toLowerCase() ?? "";
  const activities = needle
    ? plannedActivities.filter((activity) =>
        [
          activity.summary,
          activity.assignedTo.name,
          activity.location,
          activity.lead?.name,
          activity.lead?.title,
          activity.contact ? contactName(activity.contact) : null,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : plannedActivities;

  const startOfToday = new Date(new Date().toDateString());
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const overdue = activities.filter((activity) => activity.dueDate < startOfToday);
  const today = activities.filter(
    (activity) => activity.dueDate >= startOfToday && activity.dueDate < endOfToday,
  );
  const upcoming = activities.filter((activity) => activity.dueDate >= endOfToday);
  const groups = [
    {
      title: "Needs attention",
      description: "Past due and waiting for an outcome",
      items: overdue,
      icon: CircleAlert,
      tone: "danger" as const,
    },
    {
      title: "Due today",
      description: "Your active follow-up plan for today",
      items: today,
      icon: Clock3,
      tone: "warning" as const,
    },
    {
      title: "Coming up",
      description: "Planned work beyond today",
      items: upcoming,
      icon: CalendarClock,
      tone: "neutral" as const,
    },
  ];

  const scopeParams = (target: "mine" | "all") => {
    const params = new URLSearchParams();
    if (target === "all") params.set("who", "all");
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    const query = params.toString();
    return query ? `/activities?${query}` : "/activities";
  };

  const filtersActive = Boolean(q || type);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activities"
        description={
          mine
            ? "Your follow-ups, appointments and next steps in one focused queue."
            : "Every planned activity you can access across the dealership."
        }
      >
        <Link href="/calendar" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <CalendarDays className="size-4" />
          Calendar
        </Link>
        {canManage && (
          <QuickCreateButton kind="calendar" className={buttonVariants({ size: "sm" })}>
            <CalendarPlus className="size-4" />
            New activity
          </QuickCreateButton>
        )}
      </PageHeader>

      <section className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-primary/[0.08] blur-3xl" />
        <div className="relative grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
          <MetricCard
            icon={ListTodo}
            label="Planned"
            value={activities.length}
            detail={mine ? "Assigned to you" : "In accessible scope"}
            className="rounded-none border-0 shadow-none"
          />
          <MetricCard
            icon={CircleAlert}
            label="Overdue"
            value={overdue.length}
            detail={overdue.length ? "Needs attention" : "Nothing overdue"}
            accent={overdue.length > 0}
            className="rounded-none border-0 shadow-none"
          />
          <MetricCard
            icon={Clock3}
            label="Today"
            value={today.length}
            detail="Due before day end"
            className="rounded-none border-0 shadow-none"
          />
          <MetricCard
            icon={CalendarClock}
            label="Upcoming"
            value={upcoming.length}
            detail="Scheduled ahead"
            className="rounded-none border-0 shadow-none"
          />
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card/70 p-3 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex rounded-xl border border-border bg-background/50 p-1" aria-label="Activity scope">
            <Link
              href={scopeParams("mine")}
              aria-current={mine ? "page" : undefined}
              className={cn(
                "flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition sm:flex-none",
                mine ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <UserRound className="size-3.5" />
              Mine
            </Link>
            <Link
              href={scopeParams("all")}
              aria-current={!mine ? "page" : undefined}
              className={cn(
                "flex h-8 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition sm:flex-none",
                !mine ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <UsersRound className="size-3.5" />
              Accessible
            </Link>
          </div>

          <form action="/activities" className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row xl:max-w-3xl" role="search">
            {!mine && <input type="hidden" name="who" value="all" />}
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                name="q"
                defaultValue={q ?? ""}
                className="h-10 rounded-xl bg-background/50 pl-9"
                placeholder="Search activity, customer, lead or owner"
              />
            </div>
            <select name="type" defaultValue={type ?? ""} className="input h-10 rounded-xl bg-background/50 sm:w-40">
              <option value="">All types</option>
              {Object.entries(ACTIVITY_TYPES).map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </select>
            <button className={buttonVariants({ variant: "secondary" })}>Filter</button>
            {filtersActive && (
              <Link href={mine ? "/activities" : "/activities?who=all"} className={buttonVariants({ variant: "ghost" })}>
                Clear
              </Link>
            )}
          </form>
        </div>
      </section>

      {activities.length === 0 ? (
        <EmptyState
          icon={filtersActive ? Search : CalendarClock}
          title={filtersActive ? "No activities match" : "Your activity queue is clear"}
          description={
            filtersActive
              ? "Try a broader search, another activity type, or clear the current filters."
              : mine
                ? "There are no planned activities assigned to you. Schedule the next customer touchpoint when you are ready."
                : "There are no planned activities in your permitted scope."
          }
          action={filtersActive ? (
            <Link href={mine ? "/activities" : "/activities?who=all"} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Clear filters
            </Link>
          ) : undefined}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => group.items.length > 0 && (
            <Surface key={group.title}>
              <div className="flex items-center justify-between gap-4 border-b border-border bg-muted/20 px-4 py-3.5 sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-xl border",
                    group.tone === "danger"
                      ? "border-red-400/20 bg-red-400/10 text-red-300"
                      : group.tone === "warning"
                        ? "border-amber-400/20 bg-amber-400/10 text-amber-300"
                        : "border-border bg-muted/50 text-muted-foreground",
                  )}>
                    <group.icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-semibold tracking-tight text-foreground">{group.title}</h2>
                    <p className="hidden text-xs text-muted-foreground sm:block">{group.description}</p>
                  </div>
                </div>
                <span className="rounded-full border border-border bg-background/40 px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
                  {group.items.length}
                </span>
              </div>

              <div className="divide-y divide-border/70">
                {group.items.map((activity) => {
                  const meta = ACTIVITY_TYPES[activity.type] ?? DEFAULT_ACTIVITY;
                  const Icon = meta.icon;
                  const relatedHref = activity.lead
                    ? `/leads/${activity.lead.id}`
                    : activity.contact
                      ? `/contacts/${activity.contact.id}`
                      : null;
                  const relatedLabel = activity.lead
                    ? `${activity.lead.name} — ${activity.lead.title}`
                    : activity.contact
                      ? contactName(activity.contact)
                      : "General activity";

                  return (
                    <article key={activity.id} className="group relative px-4 py-4 transition-colors hover:bg-white/[0.025] sm:px-5">
                      <div className="flex items-start gap-3.5">
                        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl border", meta.tone)}>
                          <Icon className="size-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                            <div className="min-w-0">
                              <p className="font-medium leading-5 text-foreground">{activity.summary}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                {relatedHref ? (
                                  <Link href={relatedHref} className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline">
                                    <span className="truncate">{relatedLabel}</span>
                                    <ChevronRight className="size-3 shrink-0" />
                                  </Link>
                                ) : <span>{relatedLabel}</span>}
                                <span aria-hidden="true">·</span>
                                <span>{meta.label}</span>
                                {activity.location && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="size-3 shrink-0" /><span className="truncate">{activity.location}</span></span>
                                  </>
                                )}
                              </div>
                            </div>
                            <StatusPill tone={group.tone === "neutral" ? "neutral" : group.tone}>
                              {group.title}
                            </StatusPill>
                          </div>

                          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />{formatDue(activity.dueDate)}</span>
                              <span className="inline-flex items-center gap-1.5"><UserRound className="size-3.5" />{activity.assignedTo.name}</span>
                            </div>

                            {canManage && (
                              <div className="flex items-center gap-2">
                                <form action={completeActivity.bind(null, activity.id)} className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
                                  <input type="hidden" name="revalidate" value="/activities" />
                                  <input name="note" className="input h-8 min-w-0 flex-1 text-xs sm:w-40 xl:w-48" placeholder="Outcome note (optional)" aria-label={`Outcome note for ${activity.summary}`} />
                                  <button className={buttonVariants({ variant: "secondary", size: "sm" })}>
                                    <Check className="size-3.5" />
                                    Done
                                  </button>
                                </form>
                                <form action={cancelActivity.bind(null, activity.id, "/activities")}>
                                  <button type="submit" title="Cancel activity" aria-label={`Cancel ${activity.summary}`} className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "text-muted-foreground hover:text-destructive" })}>
                                    <Trash2 className="size-3.5" />
                                  </button>
                                </form>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
