import Link from "next/link";
import { notFound } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { StatusPill } from "@/components/visual-system";
import { formatDateTime } from "@/lib/format";
import { archiveCampaign, cancelCampaign, pauseCampaign, resumeCampaign, retryCampaignFailures } from "@/app/actions/marketingCampaignOperations";

type CampaignDetail = Record<string, any>;

type VersionRow = { id: string; version: number; reason: string | null; createdByName: string | null; createdAt: Date };
type EventRow = { id: string; type: string; occurredAt: Date; contactId: string | null; metadata: unknown };
type RecipientBreakdown = { status: string; count: bigint };

export default async function MarketingCampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const { id } = await params;
  const campaigns = await basePrisma.$queryRaw<CampaignDetail[]>`SELECT * FROM "Campaign" WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} LIMIT 1`;
  const campaign = campaigns[0];
  if (!campaign) notFound();
  const [versions, events, breakdown, failures] = await Promise.all([
    basePrisma.$queryRaw<VersionRow[]>`SELECT "id", "version", "reason", "createdByName", "createdAt" FROM "CampaignVersion" WHERE "campaignId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} ORDER BY "version" DESC`,
    basePrisma.$queryRaw<EventRow[]>`SELECT "id", "type", "occurredAt", "contactId", "metadata" FROM "CampaignEvent" WHERE "campaignId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} ORDER BY "occurredAt" DESC LIMIT 100`,
    basePrisma.$queryRaw<RecipientBreakdown[]>`SELECT "status", COUNT(*)::bigint AS count FROM "CampaignRecipient" WHERE "campaignId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} GROUP BY "status" ORDER BY "status"`,
    basePrisma.$queryRaw<Array<{ error: string | null; suppressionReason: string | null; count: bigint }>>`SELECT "error", "suppressionReason", COUNT(*)::bigint AS count FROM "CampaignRecipient" WHERE "campaignId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} AND ("error" IS NOT NULL OR "suppressionReason" IS NOT NULL) GROUP BY "error", "suppressionReason" ORDER BY count DESC LIMIT 20`,
  ]);
  const rate = (value: number, base: number) => base ? Math.round((value / base) * 100) : 0;
  const editable = new Set(["draft", "changes_requested"]).has(campaign.status);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-medium text-primary">Marketing / Campaigns</p><h1 className="text-2xl font-semibold tracking-[-0.03em]">{campaign.name}</h1><p className="text-sm text-muted-foreground">{campaign.objective ?? campaign.audience}</p></div><div className="flex items-center gap-2"><StatusPill tone={campaign.status === "completed" ? "success" : campaign.status.includes("error") || campaign.status === "failed" ? "danger" : "info"}>{String(campaign.status).replaceAll("_", " ")}</StatusPill>{editable && <Link href={`/marketing/campaigns/${id}/edit`} className="btn-secondary">Edit</Link>}<Link href={`/marketing/campaigns/${id}/review`} className="btn-secondary">Review</Link></div></div>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">{[
      ["Recipients", campaign.recipientCount], ["Sent", campaign.sentCount], ["Delivery", `${rate(campaign.sentCount, campaign.recipientCount)}%`], ["Open", `${rate(campaign.openCount, campaign.sentCount)}%`], ["Click", `${rate(campaign.clickCount, campaign.sentCount)}%`], ["Conversions", campaign.conversionCount]
    ].map(([label, value]) => <div className="card" key={String(label)}><p className="text-xs font-semibold uppercase text-muted-foreground">{String(label)}</p><p className="mt-1 text-2xl font-semibold">{String(value)}</p></div>)}</div>

    <div className="grid gap-4 lg:grid-cols-2"><section className="card space-y-3"><h2 className="font-semibold">Campaign brief</h2><dl className="grid gap-3 text-sm md:grid-cols-2"><div><dt className="text-muted-foreground">Audience</dt><dd>{campaign.audience}</dd></div><div><dt className="text-muted-foreground">Channel</dt><dd>{String(campaign.channel).toUpperCase()}</dd></div><div><dt className="text-muted-foreground">Offer</dt><dd>{campaign.offer ?? "—"}</dd></div><div><dt className="text-muted-foreground">CTA</dt><dd>{campaign.primaryCtaLabel ?? "—"}</dd></div><div><dt className="text-muted-foreground">Scheduled</dt><dd>{campaign.scheduledFor ? formatDateTime(campaign.scheduledFor) : "—"}</dd></div><div><dt className="text-muted-foreground">Budget</dt><dd>{campaign.budgetCents == null ? "—" : `R ${(campaign.budgetCents / 100).toLocaleString("en-ZA")}`}</dd></div></dl></section><section className="card space-y-3"><h2 className="font-semibold">Content preview</h2>{campaign.subject && <p className="font-medium">{campaign.subject}</p>}<div className="max-h-72 overflow-auto whitespace-pre-wrap text-sm text-muted-foreground">{campaign.channel === "email" ? campaign.htmlBody ?? campaign.body : campaign.body}</div></section></div>

    <section className="card space-y-3"><h2 className="font-semibold">Recipient status</h2><div className="flex flex-wrap gap-2">{breakdown.map((row) => <span className="badge" key={row.status}>{row.status.replaceAll("_", " ")}: {Number(row.count)}</span>)}</div>{failures.length > 0 && <div className="mt-3"><h3 className="text-sm font-medium">Failure and suppression reasons</h3><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{failures.map((row, index) => <li key={index}>{row.suppressionReason ?? row.error}: {Number(row.count)}</li>)}</ul></div>}</section>

    <div className="grid gap-4 lg:grid-cols-2"><section className="card space-y-3"><h2 className="font-semibold">Version history</h2><ul className="space-y-2">{versions.map((version) => <li key={version.id} className="border-b border-border/50 pb-2 text-sm"><span className="font-medium">Version {version.version}</span> · {version.reason ?? "Snapshot"}<p className="text-xs text-muted-foreground">{formatDateTime(version.createdAt)}{version.createdByName ? ` by ${version.createdByName}` : ""}</p></li>)}</ul></section><section className="card space-y-3"><h2 className="font-semibold">Event timeline</h2><ul className="max-h-96 space-y-2 overflow-auto">{events.map((event) => <li key={event.id} className="border-b border-border/50 pb-2 text-sm"><span className="font-medium">{event.type.replaceAll("_", " ")}</span><p className="text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</p></li>)}</ul></section></div>

    <section className="card space-y-3"><h2 className="font-semibold">Campaign controls</h2><div className="flex flex-wrap gap-2">{new Set(["queued","sending"]).has(campaign.status) && <form action={pauseCampaign.bind(null, id)}><button className="btn-secondary">Pause</button></form>}{campaign.status === "paused" && <form action={resumeCampaign.bind(null, id)}><button className="btn-primary">Resume</button></form>}{new Set(["sending","completed_with_errors","failed"]).has(campaign.status) && <form action={retryCampaignFailures.bind(null, id)}><button className="btn-secondary">Retry temporary failures</button></form>}{new Set(["completed","completed_with_errors","failed","cancelled"]).has(campaign.status) && <form action={archiveCampaign.bind(null, id)}><button className="btn-secondary">Archive</button></form>}</div>{new Set(["scheduled","queued","sending","paused"]).has(campaign.status) && <form action={cancelCampaign.bind(null, id)} className="mt-3 flex gap-2"><input name="reason" className="input max-w-lg" placeholder="Cancellation reason" required /><button className="btn-danger">Cancel campaign</button></form>}</section>
  </div>;
}
