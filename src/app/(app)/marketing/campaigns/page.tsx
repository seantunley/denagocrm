import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { StatusPill } from "@/components/visual-system";
import { formatDateTime } from "@/lib/format";

 type CampaignListRow = {
  id: string;
  name: string;
  channel: string;
  objective: string | null;
  audience: string;
  status: string;
  updatedAt: Date;
};

export default async function MarketingCampaignsPage() {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const campaigns = await basePrisma.$queryRaw<CampaignListRow[]>`
    SELECT "id", "name", "channel", "objective", "audience", "status", "updatedAt"
    FROM "Campaign"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
    ORDER BY "updatedAt" DESC
    LIMIT 100
  `;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-sm font-medium text-primary">Marketing</p><h1 className="text-2xl font-semibold tracking-[-0.03em]">Campaigns</h1><p className="text-sm text-muted-foreground">Create, save and reopen governed campaign drafts.</p></div>
        <Link href="/marketing/campaigns/new" className="btn-primary">Create campaign</Link>
      </div>
      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Campaign</th><th>Objective</th><th>Audience</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {campaigns.map((campaign) => <tr key={campaign.id}>
              <td><Link className="font-medium text-primary hover:underline" href={campaign.status === "draft" || campaign.status === "changes_requested" ? `/marketing/campaigns/${campaign.id}/edit` : `/campaigns/${campaign.id}`}>{campaign.name}</Link><span className="ml-2 text-xs uppercase text-muted-foreground">{campaign.channel}</span></td>
              <td className="text-muted-foreground">{campaign.objective ?? "—"}</td>
              <td className="text-muted-foreground">{campaign.audience}</td>
              <td><StatusPill tone={campaign.status === "draft" ? "neutral" : campaign.status === "changes_requested" ? "warning" : "info"}>{campaign.status.replaceAll("_", " ")}</StatusPill></td>
              <td className="text-xs text-muted-foreground">{formatDateTime(campaign.updatedAt)}</td>
            </tr>)}
            {campaigns.length === 0 && <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">No campaign drafts yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
