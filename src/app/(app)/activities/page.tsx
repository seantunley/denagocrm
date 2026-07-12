import Link from "next/link";
import { UserRound, UsersRound } from "lucide-react";
import { prisma } from "@/lib/db";
import { completeActivity, cancelActivity } from "@/app/actions/activities";
import { activityIcons } from "@/components/ActivityPanel";
import { contactName, formatDue } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ who?: string }>;
}) {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  const { who } = await searchParams;
  const mine = who !== "all";
  const [activityIds, canManage] = await Promise.all([
    getAccessibleActivityIds(user),
    hasPermission(user, "activities.manage"),
  ]);

  const activities = await prisma.activity.findMany({
    where: {
      status: "planned",
      ...(activityIds === null ? {} : { id: { in: activityIds } }),
      ...(mine ? { assignedToId: user.id } : {}),
    },
    orderBy: { dueDate: "asc" },
    include: {
      assignedTo: true,
      lead: true,
      contact: true,
    },
    take: 300,
  });

  const startOfToday = new Date(new Date().toDateString());
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const groups = [
    { title: "Overdue", items: activities.filter((activity) => activity.dueDate < startOfToday), tone: "text-red-400" },
    {
      title: "Today",
      items: activities.filter((activity) => activity.dueDate >= startOfToday && activity.dueDate < endOfToday),
      tone: "text-amber-300",
    },
    { title: "Upcoming", items: activities.filter((activity) => activity.dueDate >= endOfToday), tone: "text-slate-300" },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Activities" description={`${activities.length} accessible planned follow-up${activities.length === 1 ? "" : "s"}${mine ? " assigned to you" : " across your permitted records"}.`}>
        <Link href="/activities" className={buttonVariants({ variant: mine ? "default" : "outline", size: "sm" })}>
          <UserRound className="size-4" />Mine
        </Link>
        <Link href="/activities?who=all" className={buttonVariants({ variant: !mine ? "default" : "outline", size: "sm" })}>
          <UsersRound className="size-4" />Accessible
        </Link>
      </PageHeader>

      {activities.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-slate-400">
            No planned activities{mine ? " assigned to you" : " in your permitted scope"}.
          </p>
        </div>
      )}

      {groups.map((group) =>
        group.items.length > 0 && (
          <div key={group.title} className="card">
            <h2 className={`font-semibold mb-3 ${group.tone}`}>
              {group.title} <span className="text-slate-500 font-normal">({group.items.length})</span>
            </h2>
            <ul className="divide-y divide-slate-800">
              {group.items.map((activity) => (
                <li key={activity.id} className="py-2.5 flex items-center gap-3">
                  <span className="text-lg w-7 text-center shrink-0">{activityIcons[activity.type] ?? "☑️"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{activity.summary}</p>
                    <p className="text-xs text-slate-400">
                      {activity.lead ? (
                        <Link href={`/leads/${activity.lead.id}`} className="text-orange-400 hover:underline">
                          {activity.lead.name} — {activity.lead.title}
                        </Link>
                      ) : activity.contact ? (
                        <Link href={`/contacts/${activity.contact.id}`} className="text-orange-400 hover:underline">
                          {contactName(activity.contact)}
                        </Link>
                      ) : "General"}
                      {" · "}
                      <span className={activity.dueDate < startOfToday ? "text-red-400 font-semibold" : activity.dueDate < endOfToday ? "text-amber-300 font-semibold" : ""}>
                        {activity.dueDate < startOfToday ? "⚠ OVERDUE — " : activity.dueDate < endOfToday ? "Due today — " : ""}
                        {formatDue(activity.dueDate)}
                      </span>{" "}· {activity.assignedTo.name}
                    </p>
                  </div>
                  {canManage && (
                    <>
                      <form action={completeActivity.bind(null, activity.id)} className="flex items-center gap-1.5">
                        <input type="hidden" name="revalidate" value="/activities" />
                        <input name="note" className="input btn-sm w-40 hidden lg:block" placeholder="Outcome note…" />
                        <button className="btn-secondary btn-sm">✓ Done</button>
                      </form>
                      <form action={cancelActivity.bind(null, activity.id, "/activities")}>
                        <button className="text-xs text-slate-600 hover:text-red-500 cursor-pointer" title="Cancel">✕</button>
                      </form>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </div>
  );
}
