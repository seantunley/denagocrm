import Link from "next/link";
import { CalendarDays, ListTodo, Plus, UserRoundPlus } from "lucide-react";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { FollowUpPrompts } from "@/components/proactive/NextStep";
import DashboardScreen from "@/components/dashboard/DashboardScreen";
import {
  DEFAULT_DASHBOARD_SLUG,
  dashboardBySlug,
  defaultDashboard,
} from "@/lib/dashboard/store";
import { dashboardViewer, dashboardWindow, plannedActivities, grants } from "@/lib/dashboard/data";

/**
 * The home screen is a command centre first and a report second.
 *
 * The configurable dashboard remains intact below this shell. The shell itself is
 * deliberately opinionated: greeting, date, workload and the three actions a
 * salesperson reaches for most often. Those are navigation affordances rather
 * than dashboard cards, so they should not disappear because somebody rearranged
 * their reporting layout.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const { user, access } = await dashboardViewer();

  /*
   * The stored home dashboard, or a GENERATED default. `dashboardBySlug` is
   * scoped to the session user, so this can only ever be the caller's own.
   *
   * Nothing is written until the user's first edit, and that is deliberate:
   * a default that improves in a later release then reaches everyone who never
   * customised theirs, instead of freezing at whatever the catalogue looked like
   * on the day they signed up. Persisting `defaultDashboard()` here to "fix" the
   * missing row would quietly take that away.
   */
  const dashboard = (await dashboardBySlug(DEFAULT_DASHBOARD_SLUG)) ?? defaultDashboard();
  const { todayStart, now } = await dashboardWindow();

  const myOverdue = await prisma.activity.findMany({
    where: { status: "planned", dueDate: { lt: todayStart }, assignedToId: user.id },
    orderBy: { dueDate: "asc" },
    take: 3,
    include: { lead: true },
  });

  const seesActivities = grants(access, "activities.view", "activities.manage");
  const dueTodayCount = seesActivities ? (await plannedActivities()).today.length : null;

  const hour = Number(
    now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" }),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(/\s+/)[0];
  const dateLabel = now.toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Africa/Johannesburg",
  });

  const workloadLabel =
    dueTodayCount === null
      ? null
      : dueTodayCount === 0
        ? "Your agenda is clear today"
        : `${dueTodayCount} ${dueTodayCount === 1 ? "action" : "actions"} need your attention today`;

  return (
    <div className="space-y-7 pb-8">
      <FollowUpPrompts
        prompts={myOverdue.map((a) => ({
          id: a.id,
          type: a.type,
          summary: a.summary,
          dueLabel: formatDate(a.dueDate),
          leadId: a.leadId,
          leadName: a.lead?.name ?? null,
        }))}
      />

      <header className="flex flex-col gap-5 border-b border-border/50 pb-6 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="size-4" aria-hidden="true" />
            <span>{dateLabel}</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
            {greeting}, {firstName}
          </h1>
          {workloadLabel && (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground sm:text-base">
              <ListTodo className="size-4 shrink-0 text-primary" aria-hidden="true" />
              {workloadLabel}
            </p>
          )}
        </div>

        {/*
          EACH ACTION IS GATED ON THE PERMISSION ITS DESTINATION ENFORCES.

          The rule is the house one, stated on the nav that offers these same two
          destinations (components/nav-config.ts): the guard "applies on the page,
          so this link cannot appear for someone /fleets bounces". Ungated, these
          were three prominent primary actions that a constrained user could click
          and be silently redirected to `/` by — `/leads/new` calls
          requirePermission("leads.create"), and `/activities` calls
          requireAnyPermission("activities.view", "activities.manage").

          Not a security question — both destinations guard themselves and did so
          throughout. It is the difference between a screen that offers what you
          can do and one that offers what you cannot.

          `seesActivities` is deliberately reused rather than re-derived: it is
          already the exact pair /activities enforces, and the workload line above
          is gated on it for the same reason.
        */}
        <div className="flex flex-wrap gap-2">
          {grants(access, "leads.create") && (
            <Link
              href="/leads/new"
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <UserRoundPlus className="size-4" aria-hidden="true" />
              New lead
            </Link>
          )}
          {/*
            ONE button, not two. "Add task" and "Log activity" were separate
            buttons with separate icons pointing at the SAME url, so one of them
            was always a duplicate of the other.

            They both still land on the agenda rather than a create form, because
            there is no /activities/new — the route takes only `who`, `q` and
            `type`. Worth a dedicated create route or modal later; that is a
            product call, not something to invent while removing a duplicate.
          */}
          {seesActivities && (
            <Link
              href="/activities"
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border/70 bg-card/50 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
              Log activity
            </Link>
          )}
        </div>
      </header>

      <DashboardScreen dashboard={dashboard} tab={tab} />
    </div>
  );
}
