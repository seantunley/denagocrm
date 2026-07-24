import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { StatusPill } from "@/components/visual-system";
import { formatDateTime } from "@/lib/format";

const PAGE_SIZE = 25;

type CampaignListRow = {
  id: string;
  name: string;
  channel: string;
  objective: string | null;
  audience: string;
  status: string;
  ownerId: string | null;
  scheduledFor: Date | null;
  recipientCount: number;
  sentCount: number;
  openCount: number;
  clickCount: number;
  conversionCount: number;
  revenueCents: number;
  updatedAt: Date;
};

export default async function MarketingCampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const params = await searchParams;
  const search = String(params.q ?? "").trim();
  const status = String(params.status ?? "").trim();
  const channel = String(params.channel ?? "").trim();
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const campaigns = await basePrisma.$queryRaw<CampaignListRow[]>`
    SELECT "id", "name", "channel", "objective", "audience", "status", "ownerId", "scheduledFor",
      "recipientCount", "sentCount", "openCount", "clickCount", "conversionCount", "revenueCents", "updatedAt"
    FROM "Campaign"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND (${search} = '' OR "name" ILIKE ${`%${search}%`} OR COALESCE("objective", '') ILIKE ${`%${search}%`})
      AND (${status} = '' OR "status" = ${status})
      AND (${channel} = '' OR "channel" = ${channel})
    ORDER BY "updatedAt" DESC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `;
  const totals = await basePrisma.$queryRaw<Array<{ total: bigint; drafts: bigint; review: bigint; scheduled: bigint; sending: bigint; errors: bigint }>>`
    SELECT COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE "status" IN ('draft','changes_requested'))::bigint AS drafts,
      COUNT(*) FILTER (WHERE "status" = 'in_review')::bigint AS review,
      COUNT(*) FILTER (WHERE "status" = 'scheduled')::bigint AS scheduled,
      COUNT(*) FILTER (WHERE "status" IN ('queued','sending'))::bigint AS sending,
      COUNT(*) FILTER (WHERE "status" IN ('completed_with_errors','failed'))::bigint AS errors
    FROM "Campaign" WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  const stats = totals[0];
  const total = Number(stats?.total ?? 0);
  const query = new URLSearchParams({ ...(search ? { q: search } : {}), ...(status ? { status } : {}), ...(channel ? { channel } : {}) });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-sm font-medium text-primary">Marketing</p><h1 className="text-2xl font-semibold tracking-[-0.03em]">Campaigns</h1><p className="text-sm text-muted-foreground">Governed drafts, approvals, delivery and performance.</p></div>
        <div className="flex gap-2"><Link href="/marketing/audiences" className="btn-secondary">Audiences</Link><Link href="/marketing/templates" className="btn-secondary">Templates</Link><Link href="/marketing/campaigns/new" className="btn-primary">Create campaign</Link></div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[['Drafts', stats?.drafts], ['Awaiting review', stats?.review], ['Scheduled', stats?.scheduled], ['Sending', stats?.sending], ['Errors', stats?.errors]].map(([label, value]) => <div className="card" key={String(label)}><p className="text-xs font-semibold uppercase text-muted-foreground">{String(label)}</p><p className="mt-1 text-2xl font-semibold">{Number(value ?? 0)}</p></div>)}
      </div>

      <form className="card grid gap-3 md:grid-cols-[1fr_180px_160px_auto]">
        <input name="q" defaultValue={search} className="input" placeholder="Search campaign or objective" />
        <select name="status" defaultValue={status} className="input"><option value="">All statuses</option>{['draft','in_review','changes_requested','approved','scheduled','queued','sending','paused','completed','completed_with_errors','failed','cancelled','archived'].map((item) => <option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}</select>
        <select name="channel" defaultValue={channel} className="input"><option value="">All channels</option><option value="email">Email</option><option value="sms">SMS</option></select>
        <button className="btn-secondary">Apply filters</button>
      </form>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th className="text-right">Sent</th><th className="text-right">Delivery</th><th className="text-right">Open</th><th className="text-right">Click</th><th className="text-right">Conversions</th><th>Updated</th></tr></thead>
          <tbody>
            {campaigns.map((campaign) => {
              const delivery = campaign.recipientCount ? Math.round((campaign.sentCount / campaign.recipientCount) * 100) : 0;
              const open = campaign.sentCount ? Math.round((campaign.openCount / campaign.sentCount) * 100) : 0;
              const click = campaign.sentCount ? Math.round((campaign.clickCount / campaign.sentCount) * 100) : 0;
              return <tr key={campaign.id}>
                <td><Link className="font-medium text-primary hover:underline" href={`/marketing/campaigns/${campaign.id}`}>{campaign.name}</Link><p className="text-xs text-muted-foreground">{campaign.objective ?? campaign.channel.toUpperCase()}</p></td>
                <td><StatusPill tone={campaign.status === "completed" ? "success" : campaign.status.includes("error") || campaign.status === "failed" ? "danger" : campaign.status === "paused" || campaign.status === "changes_requested" ? "warning" : "info"}>{campaign.status.replaceAll("_", " ")}</StatusPill></td>
                <td className="text-muted-foreground">{campaign.audience}</td><td className="text-right">{campaign.sentCount}/{campaign.recipientCount}</td><td className="text-right">{delivery}%</td><td className="text-right">{campaign.channel === "email" ? `${open}%` : "—"}</td><td className="text-right">{campaign.channel === "email" ? `${click}%` : "—"}</td><td className="text-right">{campaign.conversionCount}</td><td className="text-xs text-muted-foreground">{formatDateTime(campaign.updatedAt)}</td>
              </tr>;
            })}
            {campaigns.length === 0 && <tr><td colSpan={9} className="py-12 text-center text-muted-foreground">No matching campaigns.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between text-sm"><span className="text-muted-foreground">{total} campaigns</span><div className="flex gap-2">{page > 1 && <Link className="btn-secondary btn-sm" href={`?${query.toString()}&page=${page - 1}`}>Previous</Link>}{offset + campaigns.length < total && <Link className="btn-secondary btn-sm" href={`?${query.toString()}&page=${page + 1}`}>Next</Link>}</div></div>
    </div>
  );
}
