import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { contactName, formatDateTime } from "@/lib/format";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      createdBy: true,
      recipients: {
        orderBy: [{ clickedAt: "desc" }, { openedAt: "desc" }],
        take: 100,
        include: { contact: true },
      },
    },
  });
  if (!campaign) notFound();

  const isEmail = campaign.channel === "email";
  const deliveredBase = campaign.deliveredCount || campaign.sentCount;
  const deliveryRate = campaign.sentCount > 0
    ? Math.round((campaign.deliveredCount / campaign.sentCount) * 100)
    : 0;
  const openRate = deliveredBase > 0 ? Math.round((campaign.openCount / deliveredBase) * 100) : 0;
  const clickRate = deliveredBase > 0 ? Math.round((campaign.clickCount / deliveredBase) * 100) : 0;
  const queued = Math.max(
    0,
    campaign.recipientCount - campaign.sentCount - campaign.failedCount - campaign.suppressedCount,
  );
  const clickEvents = isEmail
    ? await prisma.campaignEvent.findMany({
        where: { campaignId: campaign.id, type: "click", url: { not: null } },
        select: { url: true },
        take: 5_000,
      })
    : [];
  const topLinks = [...clickEvents.reduce((counts, event) => {
    if (event.url) counts.set(event.url, (counts.get(event.url) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <EntityDetailShell
      backHref="/campaigns"
      backLabel="Campaigns"
      eyebrow={`${campaign.channel} campaign`}
      title={campaign.name}
      status={<StatusPill tone={campaign.status === "sent" ? "success" : campaign.status === "failed" ? "danger" : "info"}>{campaign.status}</StatusPill>}
      description={campaign.subject || `${campaign.audience} audience`}
      meta={`Created ${formatDateTime(campaign.createdAt)}${campaign.createdBy ? ` by ${campaign.createdBy.name}` : ""}`}
      facts={[
        { label: "Audience", value: campaign.audience },
        { label: "Recipients", value: campaign.recipientCount },
        { label: "Accepted", value: campaign.sentCount },
        { label: "Delivered", value: campaign.deliveredCount },
        { label: "Failed", value: campaign.failedCount },
      ]}
    >

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Recipients" value={String(campaign.recipientCount)} sub={queued > 0 ? `${queued} still queued` : "all processed"} />
        <Stat label="Accepted" value={String(campaign.sentCount)} sub={campaign.suppressedCount ? `${campaign.suppressedCount} suppressed` : undefined} />
        {isEmail && <Stat label="Delivered" value={`${deliveryRate}%`} sub={`${campaign.deliveredCount} confirmed`} />}
        {isEmail && <Stat label="Opened" value={`${openRate}%`} sub={`${campaign.openCount} recipients`} />}
        {isEmail && <Stat label="Clicked" value={`${clickRate}%`} sub={`${campaign.clickCount} recipients`} />}
        {isEmail && <Stat label="Bounced" value={String(campaign.bouncedCount)} sub={`${campaign.droppedCount} dropped`} />}
        {isEmail && <Stat label="Complaints" value={String(campaign.complaintCount)} />}
        {isEmail && <Stat label="Unsubscribed" value={String(campaign.unsubscribeCount)} />}
        {!isEmail && <Stat label="Sent" value={String(campaign.sentCount)} sub={campaign.failedCount ? `${campaign.failedCount} failed` : undefined} />}
      </div>

      {isEmail && (
        <p className="text-xs text-muted-foreground">
          Open rates are approximate — some mail apps (e.g. Apple Mail Privacy Protection) auto-load
          the tracking pixel, and image-blocking hides it. Clicks are the reliable signal.
        </p>
      )}

      {isEmail && topLinks.length > 0 && (
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Top clicked links
          </p>
          <div className="space-y-2">
            {topLinks.map(([url, count]) => (
              <div key={url} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate" title={url}>{url}</span>
                <span className="tabular-nums text-muted-foreground">{count} clicks</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isEmail && campaign.htmlBody && (
        <details className="card">
          <summary className="font-semibold cursor-pointer text-sm">Preview email</summary>
          <div className="mt-3 rounded-lg overflow-hidden border border-border bg-white">
            <iframe title="Email preview" srcDoc={campaign.htmlBody} className="w-full h-[480px]" />
          </div>
        </details>
      )}

      <div className="card p-0 overflow-x-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-4 pt-4">
          Recipients {campaign.recipients.length >= 100 ? "(first 100)" : ""}
        </p>
        <table className="table-base mt-2">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Status</th>
              {isEmail && <th className="text-right">Opens</th>}
              {isEmail && <th className="text-right">Clicks</th>}
            </tr>
          </thead>
          <tbody>
            {campaign.recipients.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/contacts/${r.contactId}`} className="text-primary hover:underline">
                    {contactName(r.contact)}
                  </Link>
                </td>
                <td>
                  <StatusPill tone={
                    ["sent", "delivered"].includes(r.status)
                      ? "success"
                      : ["failed", "bounced", "dropped"].includes(r.status)
                        ? "danger"
                        : ["accepted", "processed", "deferred"].includes(r.status)
                          ? "info"
                          : "neutral"
                  }>
                    {r.status}
                  </StatusPill>
                  {r.status === "failed" && r.error ? (
                    <span className="text-xs text-muted-foreground ml-2">{r.error}</span>
                  ) : null}
                </td>
                {isEmail && <td className="text-right">{r.openCount || "—"}</td>}
                {isEmail && <td className="text-right">{r.clickCount || "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </EntityDetailShell>
  );
}
