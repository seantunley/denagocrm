import Link from "next/link";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { loadMarketingOverview } from "@/lib/marketingOverview";
import { StatusPill } from "@/components/visual-system";
import { PageHeader } from "@/components/page-header";

function monthRange(raw?: string) {
  const match = raw?.match(/^(\d{4})-(\d{2})$/);
  const current = new Date();
  const year = match ? Number(match[1]) : current.getFullYear();
  const month = match ? Number(match[2]) - 1 : current.getMonth();
  const from = new Date(year, month, 1);
  const to = new Date(year, month + 1, 1);
  return { from, to, value: `${year}-${String(month + 1).padStart(2, "0")}` };
}

export default async function MarketingCalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const params = await searchParams;
  const monthRaw = typeof params.month === "string" ? params.month : undefined;
  const kind = typeof params.kind === "string" ? params.kind : "all";
  const { from, to, value } = monthRange(monthRaw);
  const data = await loadMarketingOverview({ tenantId, from, to });
  const events = data.calendar.filter((event) => kind === "all" || event.kind === kind);
  const grouped = events.reduce<Record<string, typeof events>>((acc, event) => {
    const key = new Date(event.startsAt).toISOString().slice(0, 10);
    (acc[key] ??= []).push(event);
    return acc;
  }, {});

  const previous = new Date(from.getFullYear(), from.getMonth() - 1, 1);
  const next = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  const monthValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  return <div className="space-y-6">
    <div><Link href="/marketing/overview" className="text-sm text-primary hover:underline">← Marketing overview</Link><PageHeader className="mt-2" title="Marketing calendar" description="One schedule for governed campaign launches and survey distributions."><Link href={`/marketing/calendar?month=${monthValue(previous)}&kind=${kind}`} className="btn-secondary">Previous</Link><Link href={`/marketing/calendar?month=${monthValue(next)}&kind=${kind}`} className="btn-secondary">Next</Link></PageHeader></div>

    <form className="card flex flex-wrap items-end gap-3 p-4"><label className="space-y-1"><span className="text-xs uppercase text-muted-foreground">Month</span><input type="month" name="month" defaultValue={value} className="input-base" /></label><label className="space-y-1"><span className="text-xs uppercase text-muted-foreground">Type</span><select name="kind" defaultValue={kind} className="input-base"><option value="all">Campaigns and surveys</option><option value="campaign">Campaigns</option><option value="survey">Surveys</option></select></label><button className="btn-primary">Apply</button></form>

    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <section className="space-y-4">
        {Object.entries(grouped).map(([date, dayEvents]) => <div key={date} className="card p-0"><div className="border-b p-4"><h2 className="font-semibold">{new Date(`${date}T12:00:00`).toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long" })}</h2></div><div className="divide-y">{dayEvents.map((event) => <Link href={event.href} key={`${event.kind}:${event.id}`} className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-muted/40"><div><p className="font-medium">{event.title}</p><p className="text-xs capitalize text-muted-foreground">{event.kind}</p></div><div className="flex items-center gap-3"><StatusPill tone={event.status === "scheduled" ? "info" : event.status === "cancelled" ? "danger" : "neutral"}>{event.status.replaceAll("_", " ")}</StatusPill><time className="text-sm">{new Date(event.startsAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}</time></div></Link>)}</div></div>)}
        {events.length === 0 && <div className="card border-dashed p-12 text-center"><h2 className="font-semibold">No scheduled marketing activity</h2><p className="mt-1 text-sm text-muted-foreground">Approved campaigns and survey distributions appear here when scheduled.</p></div>}
      </section>
      <aside className="space-y-3"><div className="card p-4"><p className="text-xs uppercase text-muted-foreground">Campaign launches</p><p className="mt-1 text-2xl font-semibold">{events.filter((event) => event.kind === "campaign").length}</p></div><div className="card p-4"><p className="text-xs uppercase text-muted-foreground">Survey distributions</p><p className="mt-1 text-2xl font-semibold">{events.filter((event) => event.kind === "survey").length}</p></div><Link href="/marketing/campaigns/new" className="btn-primary block text-center">Create campaign</Link><Link href="/marketing/surveys/distributions" className="btn-secondary block text-center">Create survey distribution</Link></aside>
    </div>
  </div>;
}
