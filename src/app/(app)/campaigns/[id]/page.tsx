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

function campaignTone(status: string) {
  if (status === "completed") return "success" as const;
  if (["failed", "completed_with_errors"].includes(status)) return "danger" as const;
  if (["sending", "paused", "changes_requested"].includes(status)) return "warning" as const;
  if (["approved", "scheduled", "queued", "in_review"].includes(status)) return "info" as const;
  return "neutral" as const;
}

function recipientTone(status: string) {
  if (["sent", "delivered"].includes(status)) return "success" as const;
  if (["failed_temporary", "failed_permanent"].includes(status)) return "danger" as const;
  if (status === "suppressed") return "warning" as const;
  return "neutral" as const;
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
  const openRate = campaign.sentCount > 0 ? Math.round((campaign.openCount / campaign.sentCount) * 100) : 0;
  const clickRate = campaign.sentCount > 0 ? Math.round((campaign.clickCount / campaign.sentCount) * 100) : 0;
  const queued = Math.max(0, campaign.recipientCount - campaign.sentCount - campaign.failedCount);

  return (
    <EntityDetailShell
      backHref="/campaigns"
      backLabel="Campaigns"
      eyebrow={`${campaign.channel} campaign`}
      title={campaign.name}
      status={<StatusPill tone={campaignTone(campaign.status)}>{campaign.status.replaceAll("_", " ")}</StatusPill>}
      description={campaign.subject || `${campaign.audience} audience`}
      meta={`Created ${formatDateTime(campaign.createdAt)}${campaign.createdBy ? ` by ${campaign.createdBy.name}` : ""}`}
      facts={[
        { label: "Audience", value: campaign.audience },
        { label: "Recipients", value: campaign.recipientCount },
        { label: "Sent", value: campaign.sentCount },
        { label: "Failed", value: campaign.failedCount },
      ]}
    >

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Recipients" value={String(campaign.recipientCount)} sub={queued > 0 ? `${queued} still queued` : "all processed"} />
        <Stat label="Sent" value={String(campaign.sentCount)} sub={campaign.failedCount ? `${campaign.failedCount} failed` : undefined} />
        {isEmail && <Stat label="Opened" value={`${openRate}%`} sub={`${campaign.openCount} recipients`} />}
        {isEmail && <Stat label="Clicked" value={`${clickRate}%`} sub={`${campaign.clickCount} recipients`} />}
      </div>

      {isEmail && (
        <p className="text-xs text-muted-foreground">
          Open rates are approximate — some mail apps (e.g. Apple Mail Privacy Protection) auto-load
          the tracking pixel, and image-blocking hides it. Clicks are the reliable signal.
        </p>
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
                  <StatusPill tone={recipientTone(r.status)}>{r.status.replaceAll("_", " ")}</StatusPill>
                  {["failed_temporary", "failed_permanent"].includes(r.status) && r.error ? (
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
