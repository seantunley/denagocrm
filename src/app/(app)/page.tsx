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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const { user, access } = await dashboardViewer();
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
  const date = now.toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Africa/Johannesburg",
  });

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6 pb-10">
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

      <header className="flex flex-col gap-1 border-b border-border/45 pb-5">
        <p className="text-xs font-medium text-muted-foreground">{date}</p>
        <h1 className="text-[1.7rem] font-semibold tracking-[-0.025em] text-foreground sm:text-[2rem]">
          {greeting}, {firstName}
        </h1>
        {dueTodayCount !== null && (
          <p className="mt-1 text-sm text-muted-foreground">
            {dueTodayCount === 0
              ? "You’re clear for today."
              : `${dueTodayCount} ${dueTodayCount === 1 ? "item" : "items"} need your attention today.`}
          </p>
        )}
      </header>

      <DashboardScreen dashboard={dashboard} tab={tab} />
    </div>
  );
}
