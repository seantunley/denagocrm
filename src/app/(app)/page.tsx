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
 * The home screen: the user's own dashboard.
 *
 * This page used to be ~890 lines of queries and markup, then a thin shell over
 * a flat list of twelve fixed cards. It is now a shell over a CONFIG — tabs,
 * sections, and cards the user built — and the only thing that makes it "home"
 * is which dashboard it resolves to.
 *
 * ── NOT YET TAKEN CONTROL ───────────────────────────────────────────────────
 *
 * A user with no stored dashboard gets `defaultDashboard()`, which is generated
 * from the card catalogue rather than read from the database. Nothing is written
 * until their first edit. That matters for two reasons: a brand-new user's home
 * screen is exactly what it has always been with no migration to run, and a
 * default that IMPROVES in a later release reaches everyone who never customised
 * theirs, instead of freezing at whatever the catalogue looked like on the day
 * they signed up.
 *
 * ── WHAT IS NOT A CARD, AND WHY ─────────────────────────────────────────────
 *
 * The greeting and the follow-up prompts sit outside the dashboard entirely.
 * The prompts are an INTERACTION — mark it done, or do not — rather than a
 * summary, and they are about the viewer's own overdue work. A user who
 * rearranged them off their screen would silently stop being asked about it.
 * Everything that is a summary is a card; these two are not.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const { user, access } = await dashboardViewer();

  // The stored home dashboard, or the generated one. `dashboardBySlug` is
  // scoped to the session user, so this can only ever be the caller's own.
  const dashboard = (await dashboardBySlug(DEFAULT_DASHBOARD_SLUG)) ?? defaultDashboard();

  const { todayStart, now } = await dashboardWindow();

  // The viewer's OWN overdue items. Inherently self-scoped — assignedToId is the
  // caller — so this shows nobody else's work regardless of permissions.
  const myOverdue = await prisma.activity.findMany({
    where: { status: "planned", dueDate: { lt: todayStart }, assignedToId: user.id },
    orderBy: { dueDate: "asc" },
    take: 3,
    include: { lead: true },
  });

  // Drawn from the same query the agenda card uses (memoised, so it is free
  // here), and shown only to someone who may see activities at all — otherwise
  // the subtitle would quietly report the size of a queue they cannot open.
  const seesActivities = grants(access, "activities.view", "activities.manage");
  const dueTodayCount = seesActivities ? (await plannedActivities()).today.length : null;

  const hour = Number(
    now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" }),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(/\s+/)[0];

  return (
    <div className="space-y-5">
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

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {greeting}, {firstName}
        </h1>
        {dueTodayCount !== null && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {dueTodayCount === 0
              ? "Nothing on the agenda today — a clean slate."
              : `${dueTodayCount} ${dueTodayCount === 1 ? "item" : "items"} on today's agenda.`}
          </p>
        )}
      </div>

      <DashboardScreen dashboard={dashboard} tab={tab} />
    </div>
  );
}
