import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { completeActivity, cancelActivity } from "@/app/actions/activities";
import { activityIcons } from "@/components/ActivityPanel";
import { contactName, formatDate } from "@/lib/format";

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ who?: string }>;
}) {
  const user = await requireUser();
  const { who } = await searchParams;
  const mine = who !== "all";

  const activities = await prisma.activity.findMany({
    where: {
      status: "planned",
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
    { title: "Overdue", items: activities.filter((a) => a.dueDate < startOfToday), tone: "text-red-400" },
    {
      title: "Today",
      items: activities.filter((a) => a.dueDate >= startOfToday && a.dueDate < endOfToday),
      tone: "text-amber-300",
    },
    { title: "Upcoming", items: activities.filter((a) => a.dueDate >= endOfToday), tone: "text-slate-300" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Activities</h1>
        <div className="flex gap-2">
          <Link href="/activities" className={mine ? "btn-primary" : "btn-secondary"}>
            Mine
          </Link>
          <Link href="/activities?who=all" className={!mine ? "btn-primary" : "btn-secondary"}>
            Everyone
          </Link>
        </div>
      </div>

      {activities.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-slate-400">
            No planned activities{mine ? " assigned to you" : ""}. Schedule follow-ups from any
            lead or contact page.
          </p>
        </div>
      )}

      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <div key={g.title} className="card">
              <h2 className={`font-semibold mb-3 ${g.tone}`}>
                {g.title} <span className="text-slate-500 font-normal">({g.items.length})</span>
              </h2>
              <ul className="divide-y divide-slate-800">
                {g.items.map((a) => (
                  <li key={a.id} className="py-2.5 flex items-center gap-3">
                    <span className="text-lg w-7 text-center shrink-0">
                      {activityIcons[a.type] ?? "☑️"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.summary}</p>
                      <p className="text-xs text-slate-400">
                        {a.lead ? (
                          <Link href={`/leads/${a.lead.id}`} className="text-orange-400 hover:underline">
                            {a.lead.title}
                          </Link>
                        ) : a.contact ? (
                          <Link href={`/contacts/${a.contact.id}`} className="text-orange-400 hover:underline">
                            {contactName(a.contact)}
                          </Link>
                        ) : (
                          "General"
                        )}
                        {" · "}
                        {formatDate(a.dueDate)} · {a.assignedTo.name}
                      </p>
                    </div>
                    <form action={completeActivity.bind(null, a.id)} className="flex items-center gap-1.5">
                      <input type="hidden" name="revalidate" value="/activities" />
                      <input
                        name="note"
                        className="input btn-sm w-40 hidden lg:block"
                        placeholder="Outcome note…"
                      />
                      <button className="btn-secondary btn-sm">✓ Done</button>
                    </form>
                    <form action={cancelActivity.bind(null, a.id, "/activities")}>
                      <button className="text-xs text-slate-600 hover:text-red-500 cursor-pointer" title="Cancel">
                        ✕
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          )
      )}
    </div>
  );
}
