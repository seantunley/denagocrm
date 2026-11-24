import Link from "next/link";
import { ListTodo } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { loadMyWork } from "@/lib/myWork/load";
import { WORK_AREAS, WORK_BUCKETS, groupWork, workKey, type WorkArea } from "@/lib/myWork/rules";
import { getRegionalSettings } from "@/lib/settings";
import { formatDate, formatDue } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState, StatusPill } from "@/components/visual-system";

export const metadata = { title: "My Work" };

/**
 * My Work — everything waiting on me, from every area, in one list by day
 * (Sean, 2026-11-24). Each row opens the record where the work is done; doing it
 * there is what takes it off this list.
 */
export default async function MyWorkPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  await requireModuleEnabled("work");
  const user = await requireUser();
  const { area } = await searchParams;
  const only = WORK_AREAS.find((a) => a === area) as WorkArea | undefined;
  const now = new Date();
  const [all, regional] = await Promise.all([loadMyWork(user, now), getRegionalSettings()]);
  const items = only ? all.filter((item) => item.area === only) : all;
  const groups = groupWork(items, now);
  const areasHere = WORK_AREAS.filter((a) => all.some((item) => item.area === a));

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <ListTodo className="size-5 text-primary" />
            My Work
          </span>
        }
        description="Everything waiting on you — deals to contact, tasks, deliveries, job cards, cases and approvals — by when it is due. Open a row to do it; it leaves this list once it is done."
      />

      {areasHere.length > 1 && (
        <nav className="flex flex-wrap gap-2" aria-label="Area">
          <Link href="/work" className={only ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>All</Link>
          {areasHere.map((a) => (
            <Link key={a} href={`/work?area=${a}`} className={only === a ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>
              {a}
            </Link>
          ))}
        </nav>
      )}

      {items.length === 0 ? (
        <EmptyState icon={ListTodo} title="Nothing waiting on you." description="No deal, task, delivery, job card, case or approval is on you right now." />
      ) : (
        WORK_BUCKETS.filter((bucket) => groups[bucket.key].length > 0).map((bucket) => (
          <section key={bucket.key} className="space-y-2">
            <h2 className="text-sm font-semibold">
              {bucket.label} <span className="text-muted-foreground">({groups[bucket.key].length})</span>
            </h2>
            <ul className="divide-y rounded-lg border">
              {groups[bucket.key].map((item) => (
                <li key={workKey(item)}>
                  <Link href={item.href} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-muted/50">
                    <StatusPill tone={item.urgent ? "danger" : "neutral"}>{item.area}</StatusPill>
                    <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                    <span className="text-xs text-muted-foreground">{item.reason}</span>
                    {item.kind === "suggestion" && (
                      <span className="text-[11px] text-muted-foreground" title="Worked out from the record, not a task someone set. It goes when the record changes.">Suggested</span>
                    )}
                    {item.due && bucket.key !== "waiting" && !(bucket.key === "today" && item.allDay) && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {item.allDay ? formatDate(item.due, regional) : formatDue(item.due, regional)}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
