import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Clock, ListTodo, ShieldCheck, Stamp, Ticket, TrendingUp, Truck, Users, Wrench, Zap } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { loadMyWork, myDealsAtRisk } from "@/lib/myWork/load";
import { ACTION_LABEL, WORK_AREAS, priorityOf, rankWork, workKey, type WorkArea, type WorkBucket } from "@/lib/myWork/rules";
import { getRegionalSettings } from "@/lib/settings";
import { johannesburgDateKey } from "@/lib/activityDay";
import { formatDate, formatDue } from "@/lib/format";
import { MetricCard, EmptyState, StatusPill } from "@/components/visual-system";
import { MobileDataCard, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";
import { CardEmpty, CardRow, CentreCards, CentreHeader, CentreMain, Panel, StatRow, ViewChips } from "@/components/centre";

export const metadata = { title: "My Work" };

const DUE_TONE = { overdue: "danger", today: "warning", upcoming: "info", undated: "neutral", waiting: "neutral" } as const satisfies Record<WorkBucket, string>;
const AREA_ICON = { Sales: TrendingUp, Workshop: Wrench, Deliveries: Truck, Approvals: Stamp, Support: Ticket } as const satisfies Record<WorkArea, unknown>;
const PRIORITY_TONE = { High: "danger", Medium: "warning", Low: "neutral" } as const;

/**
 * My Work — everything waiting on me, from every area, most pressing first
 * (brief §6; layout from Sean's mockups, 2026-11-24). Each row opens the record
 * where the work is done; doing it there takes it off this list.
 */
export default async function MyWorkPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  await requireModuleEnabled("work");
  const user = await requireUser();
  const { area } = await searchParams;
  const only = WORK_AREAS.find((a) => a === area) as WorkArea | undefined;
  const now = new Date();
  const [all, atRisk, regional] = await Promise.all([loadMyWork(user, now), myDealsAtRisk(user, now), getRegionalSettings()]);
  const ranked = rankWork(all, now);
  const rows = only ? ranked.filter((item) => item.area === only) : ranked;
  const count = (bucket: WorkBucket) => ranked.filter((item) => item.bucket === bucket).length;
  const approvals = ranked.filter((item) => item.area === "Approvals");
  const time = new Intl.DateTimeFormat("en-ZA", { timeZone: regional.timeZone, hour: "2-digit", minute: "2-digit" });
  // Today's timed commitments, in time order: the calendar card.
  const calendar = ranked
    .filter((item) => item.source.type === "activity" && !item.allDay && item.due && johannesburgDateKey(item.due) === johannesburgDateKey(now))
    .sort((a, b) => a.due!.getTime() - b.due!.getTime());

  const focus = [
    { icon: Clock, title: "Catch up what is late", count: count("overdue"), detail: "past their date or time", href: "/work" },
    { icon: Users, title: "Customers waiting on you", count: ranked.filter((i) => i.area === "Sales" && i.kind === "suggestion" && !i.waiting).length, detail: "deals worth contacting today", href: "/work?area=Sales" },
    { icon: Stamp, title: "Decisions only you can make", count: approvals.length, detail: "approvals addressed to you", href: "/work?area=Approvals" },
    { icon: ShieldCheck, title: "Urgent jobs and cases", count: ranked.filter((i) => i.urgent).length, detail: "marked urgent", href: "/work" },
  ].filter((f) => f.count > 0);

  return (
    <div className="space-y-5">
      <CentreHeader
        title="My Work"
        description="Everything waiting on you, in one place."
        note="Ranked by how late, how urgent and when it is due"
        actions={<Link href="/calendar" className="btn-primary btn-sm"><CalendarDays className="size-4" />Calendar</Link>}
      />

      <StatRow>
        <MetricCard icon={CheckCircle2} label="Due today" value={count("today")} detail="Still to do today" accent />
        <MetricCard icon={AlertTriangle} label="Overdue" value={count("overdue")} detail="Past their date or time" />
        <MetricCard icon={Stamp} label="Approvals waiting" value={approvals.length} detail="Waiting for your decision" />
        <MetricCard icon={Users} label="Waiting on others" value={count("waiting")} detail="Customers and signers to come back" />
      </StatRow>

      <CentreMain
        aside={
          <Panel icon={Zap} title="Focus today" description="Where your time does the most, from what is on your list.">
            {focus.length === 0 ? (
              <CardEmpty>Nothing pressing — you are clear.</CardEmpty>
            ) : (
              <ul className="space-y-1">
                {focus.map((f) => (
                  <li key={f.title}>
                    <Link href={f.href} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
                      <f.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{f.title}</span>
                        <span className="block text-xs text-muted-foreground">{f.count} {f.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        }
      >
        <Panel icon={ListTodo} title="Prioritised work queue" description="Your list across sales, deliveries, the workshop, support and approvals — most pressing first.">
          <ViewChips
            label="Area"
            active={only ?? "all"}
            chips={[
              { key: "all", label: "All work", href: "/work", count: ranked.length },
              ...WORK_AREAS.filter((a) => ranked.some((item) => item.area === a)).map((a) => ({
                key: a,
                label: a,
                href: `/work?area=${a}`,
                count: ranked.filter((item) => item.area === a).length,
              })),
            ]}
          />
          {rows.length === 0 ? (
            <EmptyState icon={ListTodo} title="Nothing waiting on you." description="No deal, task, delivery, job card, case or approval is on you right now." />
          ) : (
            <ResponsiveDataView
              mobile={
                <MobileDataList>
                  {rows.map((item) => (
                    <MobileDataCard key={workKey(item)}>
                      <MobileDataHeader
                        title={<Link href={item.href} className="text-primary hover:underline">{item.title}</Link>}
                        detail={item.reason}
                        aside={<StatusPill tone={DUE_TONE[item.bucket]}>{item.waiting ? "Waiting" : !item.due ? "No date" : item.bucket === "today" ? "Today" : formatDate(item.due, regional)}</StatusPill>}
                      />
                      <Link href={item.href} className="btn-secondary btn-sm">{ACTION_LABEL[item.source.type]}<ArrowRight className="size-3.5" /></Link>
                    </MobileDataCard>
                  ))}
                </MobileDataList>
              }
              desktop={
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Title</th>
                    <th>Due</th>
                    <th>Priority</th>
                    <th>Why it is here</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const priority = priorityOf(item, item.bucket);
                    const AreaIcon = AREA_ICON[item.area];
                    return (
                      <tr key={workKey(item)}>
                        <td className="whitespace-nowrap text-sm">
                          <span className="inline-flex items-center gap-1.5"><AreaIcon className="size-3.5 text-primary" />{item.area}</span>
                        </td>
                        <td>
                          <Link href={item.href} className="font-medium hover:underline">{item.title}</Link>
                          {item.kind === "suggestion" && (
                            <span className="ml-2 text-[11px] text-muted-foreground" title="Worked out from the record, not a task someone set. It goes when the record changes.">Suggested</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <StatusPill tone={DUE_TONE[item.bucket]}>
                            {item.waiting ? "Waiting" : !item.due ? "No date" : item.bucket === "today" && item.allDay ? "Today" : item.allDay ? formatDate(item.due, regional) : formatDue(item.due, regional)}
                          </StatusPill>
                        </td>
                        <td><StatusPill tone={PRIORITY_TONE[priority]}>{priority}</StatusPill></td>
                        <td className="max-w-80 text-xs text-muted-foreground">{item.reason}</td>
                        <td className="text-right">
                          <Link href={item.href} className="btn-secondary btn-sm">{ACTION_LABEL[item.source.type]}<ArrowRight className="size-3.5" /></Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
              }
            />
          )}
        </Panel>
      </CentreMain>

      <CentreCards>
        <Panel icon={CalendarDays} title="My calendar" description="Your timed commitments today." action={<Link href="/calendar" className="text-primary hover:underline">View calendar</Link>}>
          {calendar.length === 0 ? (
            <CardEmpty>Nothing booked at a set time today.</CardEmpty>
          ) : (
            calendar.slice(0, 5).map((item) => (
              <CardRow key={workKey(item)} href={item.href} title={item.title} detail={item.reason} aside={<span className="tabular-nums text-muted-foreground">{time.format(item.due!)}</span>} />
            ))
          )}
        </Panel>
        <Panel icon={Stamp} title="Approvals waiting" description="Waiting for your decision." action={approvals.length > 3 ? <Link href="/work?area=Approvals" className="text-primary hover:underline">View all ({approvals.length})</Link> : undefined}>
          {approvals.length === 0 ? (
            <CardEmpty>No approvals waiting for you.</CardEmpty>
          ) : (
            approvals.slice(0, 3).map((item) => <CardRow key={workKey(item)} href={item.href} title={item.title} detail={item.reason} aside={<span className="text-primary">Approve</span>} />)
          )}
        </Panel>
        <Panel icon={AlertTriangle} title="Deals at risk" description="Your deals the Attention Centre says need acting on." action={<Link href="/leads/attention" className="text-primary hover:underline">Attention Centre</Link>}>
          {atRisk.length === 0 ? (
            <CardEmpty>None of your deals is at risk.</CardEmpty>
          ) : (
            atRisk.map((lead) => (
              <CardRow key={lead.id} href={`/leads/${lead.id}`} title={lead.name} detail={lead.reason} aside={<StatusPill tone={lead.band === "urgent" ? "danger" : "warning"}>{lead.band === "urgent" ? "Urgent" : "Act"}</StatusPill>} />
            ))
          )}
        </Panel>
      </CentreCards>
    </div>
  );
}
