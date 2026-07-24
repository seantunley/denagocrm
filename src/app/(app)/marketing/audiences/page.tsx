import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { archiveMarketingAudience, createMarketingAudience, updateMarketingAudience } from "@/app/actions/marketingContent";
import { formatDateTime } from "@/lib/format";

type AudienceRow = { id: string; name: string; ruleTree: unknown; status: string; lastCalculatedCount: number; lastCalculatedAt: Date | null; updatedAt: Date };

const DEFAULT_TREE = JSON.stringify({ operator: "AND", rules: [{ field: "province", operator: "equals", value: "Western Cape" }], exclusions: [] }, null, 2);

export default async function MarketingAudiencesPage() {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const audiences = await basePrisma.$queryRaw<AudienceRow[]>`SELECT "id", "name", "ruleTree", "status", "lastCalculatedCount", "lastCalculatedAt", "updatedAt" FROM "Segment" WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId} ORDER BY "status", "updatedAt" DESC`;
  return <div className="space-y-5"><div><p className="text-sm font-medium text-primary">Marketing</p><h1 className="text-2xl font-semibold">Audiences</h1><p className="text-sm text-muted-foreground">Versioned include/exclude rule trees with live counts.</p></div>
    <form action={createMarketingAudience} className="card space-y-3"><h2 className="font-semibold">Create audience</h2><input name="name" className="input" placeholder="Audience name" required /><textarea name="ruleTree" className="input min-h-56 font-mono text-xs" defaultValue={DEFAULT_TREE} required /><button className="btn-primary">Create and calculate</button></form>
    <div className="grid gap-4 lg:grid-cols-2">{audiences.map((audience) => <section className="card space-y-3" key={audience.id}><div className="flex justify-between gap-3"><div><h2 className="font-semibold">{audience.name}</h2><p className="text-xs text-muted-foreground">{audience.lastCalculatedCount} contacts · {audience.lastCalculatedAt ? formatDateTime(audience.lastCalculatedAt) : "not calculated"}</p></div><span className="badge">{audience.status}</span></div><form action={updateMarketingAudience.bind(null, audience.id)} className="space-y-2"><textarea name="ruleTree" className="input min-h-48 font-mono text-xs" defaultValue={JSON.stringify(audience.ruleTree, null, 2)} required /><button className="btn-secondary">Save new version</button></form>{audience.status !== "archived" && <form action={archiveMarketingAudience.bind(null, audience.id)}><button className="btn-danger btn-sm">Archive</button></form>}</section>)}</div>
  </div>;
}
