import Link from "next/link";
import { BadgePoundSterling, ChartNoAxesCombined, MousePointerClick, UsersRound } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { loadMarketingOverview } from "@/lib/marketingOverview";
import { MetricCard, MetricStrip, StatusPill, WorkspaceToolbar } from "@/components/visual-system";
import MarketingPageHeader from "@/components/marketing/MarketingPageHeader";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";

function money(cents: number) {
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(cents / 100);
}

function parseDate(value: string | string[] | undefined, fallback: Date) {
  const raw = Array.isArray(value) ? value[0] : value;
  const date = raw ? new Date(raw) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export default async function MarketingOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const params = await searchParams;
  const now = new Date();
  const from = parseDate(params.from, new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000));
  const toInput = parseDate(params.to, now);
  const to = new Date(toInput.getTime() + 24 * 60 * 60 * 1000);
  const data = await loadMarketingOverview({ tenantId, from, to });

  return <div className="space-y-6">
    <MarketingPageHeader title="Performance overview" description="Campaign execution, attributable pipeline, survey health and the work that needs attention.">
      <Link href="/marketing/campaigns/new" className="btn-primary">Create campaign</Link><Link href="/marketing/calendar" className="btn-secondary">Marketing calendar</Link>
    </MarketingPageHeader>

    <WorkspaceToolbar>
      <form className="flex flex-wrap items-end gap-3"><div className="mr-auto"><p className="text-sm font-semibold">Reporting window</p><p className="mt-0.5 text-xs text-muted-foreground">All attribution and feedback metrics below use this period.</p></div><label className="space-y-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</span><input type="date" name="from" defaultValue={from.toISOString().slice(0,10)} className="input-base" /></label><label className="space-y-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To</span><input type="date" name="to" defaultValue={toInput.toISOString().slice(0,10)} className="input-base" /></label><button className="btn-primary">Apply period</button></form>
    </WorkspaceToolbar>

    <MetricStrip glow="left">
      <MetricCard icon={ChartNoAxesCombined} label="Campaign activity" value={data.campaigns.campaigns} detail={`${data.campaigns.delivered || data.campaigns.sent} delivered`} />
      <MetricCard icon={UsersRound} label="Attributed outcomes" value={data.campaigns.conversions} detail={`${data.campaigns.sales} sales from campaign leads`} accent={data.campaigns.conversions > 0} />
      <MetricCard icon={BadgePoundSterling} label="Attributed revenue" value={money(data.campaigns.attributedRevenueCents)} detail={data.efficiency.roas === null ? "ROAS not available" : `${data.efficiency.roas}× return on spend`} />
      <MetricCard icon={MousePointerClick} label="Engagement" value={data.campaigns.clicked} detail={data.efficiency.costPerLeadCents === null ? "Cost per lead not available" : `${money(data.efficiency.costPerLeadCents)} per lead`} />
    </MetricStrip>

    <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
      <ResponsiveEntityTable>
        <div className="flex items-center justify-between p-5"><div><h2 className="font-semibold">Top attributable campaigns</h2><p className="text-sm text-muted-foreground">Last-click conversions inside each campaign’s configured window.</p></div><Link href="/marketing/campaigns" className="text-sm text-primary hover:underline">All campaigns</Link></div>
        <table className="table-base"><thead><tr><th>Campaign</th><th>Status</th><th>Clicks</th><th>Conversions</th><th>Revenue</th><th>ROAS</th></tr></thead><tbody>{data.topCampaigns.map((campaign) => {
          const roas = campaign.budgetCents && campaign.budgetCents > 0 ? Math.round((campaign.attributedRevenueCents / campaign.budgetCents) * 100) / 100 : null;
          return <tr key={campaign.id}><td data-primary data-label="Campaign"><Link href={`/marketing/campaigns/${campaign.id}`} className="font-medium text-primary hover:underline">{campaign.name}</Link><span className="ml-2 text-xs uppercase text-muted-foreground">{campaign.channel}</span></td><td data-label="Status"><StatusPill tone={campaign.status === "completed" ? "success" : campaign.status === "completed_with_errors" ? "warning" : "neutral"}>{campaign.status.replaceAll("_", " ")}</StatusPill></td><td data-label="Clicks">{campaign.clickCount}</td><td data-label="Conversions">{campaign.conversionCount}</td><td data-label="Revenue">{money(campaign.attributedRevenueCents)}</td><td data-label="ROAS">{roas === null ? "—" : `${roas}×`}</td></tr>;
        })}{data.topCampaigns.length === 0 && <tr><td data-empty colSpan={6} className="py-10 text-center text-muted-foreground">No campaigns in this period.</td></tr>}</tbody></table>
      </ResponsiveEntityTable>

      <section className="card space-y-4 p-5">
        <div><h2 className="font-semibold">Work queues</h2><p className="text-sm text-muted-foreground">Governed items waiting for human attention.</p></div>
        <Link href="/marketing/campaigns?status=in_review" className="flex justify-between rounded-lg border p-3 hover:bg-muted/40"><span>Campaigns awaiting review</span><strong>{data.workQueues.campaign_review ?? 0}</strong></Link>
        <Link href="/marketing/campaigns?status=completed_with_errors" className="flex justify-between rounded-lg border p-3 hover:bg-muted/40"><span>Campaign delivery issues</span><strong>{data.workQueues.campaign_errors ?? 0}</strong></Link>
        <Link href="/marketing/surveys" className="flex justify-between rounded-lg border p-3 hover:bg-muted/40"><span>Surveys awaiting review</span><strong>{data.workQueues.survey_review ?? 0}</strong></Link>
        <Link href="/marketing/surveys/insights" className="flex justify-between rounded-lg border p-3 hover:bg-muted/40"><span>Customer recovery follow-ups</span><strong>{data.workQueues.survey_follow_up ?? 0}</strong></Link>
      </section>
    </div>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold">Survey health</h2><p className="text-sm text-muted-foreground">Distribution and closed-loop activity in the period.</p></div><Link href="/marketing/surveys/insights" className="text-sm text-primary hover:underline">Open insights</Link></div><div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-lg border p-3"><p className="text-xs uppercase text-muted-foreground">Distributions</p><p className="text-2xl font-semibold">{data.surveys.distributions}</p></div><div className="rounded-lg border p-3"><p className="text-xs uppercase text-muted-foreground">Responses</p><p className="text-2xl font-semibold">{data.surveys.completed}</p></div><div className="rounded-lg border p-3"><p className="text-xs uppercase text-muted-foreground">Response rate</p><p className="text-2xl font-semibold">{data.surveys.sent ? `${Math.round((data.surveys.completed / data.surveys.sent) * 1000) / 10}%` : "0%"}</p></div><div className="rounded-lg border p-3"><p className="text-xs uppercase text-muted-foreground">Open recoveries</p><p className="text-2xl font-semibold">{data.surveys.unresolved}</p></div></div></section>
      <section className="card p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold">Upcoming marketing calendar</h2><p className="text-sm text-muted-foreground">Scheduled campaigns and survey distributions.</p></div><Link href="/marketing/calendar" className="text-sm text-primary hover:underline">Full calendar</Link></div><div className="mt-4 space-y-2">{data.calendar.slice(0,8).map((event) => <Link href={event.href} key={`${event.kind}:${event.id}`} className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/40"><div><p className="font-medium">{event.title}</p><p className="text-xs capitalize text-muted-foreground">{event.kind} · {event.status.replaceAll("_", " ")}</p></div><time className="text-xs text-muted-foreground">{new Date(event.startsAt).toLocaleString("en-ZA")}</time></Link>)}{data.calendar.length === 0 && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Nothing scheduled in this period.</p>}</div></section>
    </div>
  </div>;
}
