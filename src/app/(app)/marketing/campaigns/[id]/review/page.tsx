import { notFound } from "next/navigation";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { readCampaignDraftRecord } from "@/lib/marketingCampaignDrafts";
import { campaignQa } from "@/lib/marketingCampaignWorkflow";
import {
  approveCampaign,
  requestCampaignChanges,
  scheduleCampaign,
  sendApprovedCampaignNow,
  submitCampaignForReview,
} from "@/app/actions/marketingCampaignWorkflow";
import { StatusPill } from "@/components/visual-system";

export default async function ReviewCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const { id } = await params;
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) notFound();
  const issues = await campaignQa(id, tenantId);
  const errors = issues.filter((issue) => issue.severity === "error");

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-sm font-medium text-primary">Marketing / Campaign review</p><h1 className="text-2xl font-semibold tracking-[-0.03em]">{campaign.name}</h1><p className="text-sm text-muted-foreground">Review the frozen launch fields before approval and scheduling.</p></div>
        <StatusPill tone={campaign.status === "approved" ? "success" : campaign.status === "changes_requested" ? "warning" : "info"}>{campaign.status.replaceAll("_", " ")}</StatusPill>
      </div>

      <section className="card space-y-3">
        <h2 className="font-semibold">QA checklist</h2>
        {issues.length === 0 ? <p className="text-sm text-emerald-400">All checks passed.</p> : <ul className="space-y-2">{issues.map((issue) => <li key={`${issue.code}-${issue.message}`} className={issue.severity === "error" ? "text-sm text-red-400" : "text-sm text-amber-300"}>{issue.severity === "error" ? "Error" : "Warning"}: {issue.message}</li>)}</ul>}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-3"><h2 className="font-semibold">Brief</h2><dl className="space-y-2 text-sm"><div><dt className="text-muted-foreground">Objective</dt><dd>{campaign.objective ?? "—"}</dd></div><div><dt className="text-muted-foreground">Offer</dt><dd>{campaign.offer ?? "—"}</dd></div><div><dt className="text-muted-foreground">Audience</dt><dd>{campaign.audience}</dd></div><div><dt className="text-muted-foreground">Success metric</dt><dd>{campaign.successMetric ?? "—"}</dd></div></dl></div>
        <div className="card space-y-3"><h2 className="font-semibold">Content</h2><p className="text-xs uppercase text-muted-foreground">{campaign.channel}</p>{campaign.subject && <p className="font-medium">{campaign.subject}</p>}<div className="max-h-64 overflow-auto whitespace-pre-wrap text-sm text-muted-foreground">{campaign.channel === "email" ? campaign.htmlBody ?? campaign.body : campaign.body}</div></div>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Workflow actions</h2>
        {campaign.status === "draft" || campaign.status === "changes_requested" ? <form action={submitCampaignForReview.bind(null, id)}><button className="btn-primary" disabled={errors.length > 0}>Submit for review</button></form> : null}
        {campaign.status === "in_review" ? <div className="grid gap-4 md:grid-cols-2">
          <form action={requestCampaignChanges.bind(null, id)} className="space-y-2"><label className="space-y-1 block"><span className="label">Required changes</span><textarea name="note" className="input min-h-24" required /></label><button className="btn-secondary">Request changes</button></form>
          <form action={approveCampaign.bind(null, id)} className="space-y-2"><label className="space-y-1 block"><span className="label">Approval note</span><textarea name="note" className="input min-h-24" /></label><button className="btn-primary" disabled={errors.length > 0}>Approve campaign</button></form>
        </div> : null}
        {campaign.status === "approved" ? <div className="grid gap-4 md:grid-cols-2">
          <form action={sendApprovedCampaignNow.bind(null, id)} className="card border-primary/30 space-y-2"><p className="font-medium">Send now</p><p className="text-xs text-muted-foreground">Freezes the audience and queues recipients. Delivery remains asynchronous.</p><button className="btn-primary">Queue campaign</button></form>
          <form action={scheduleCampaign.bind(null, id)} className="card border-primary/30 space-y-2"><label className="space-y-1 block"><span className="label">Schedule date and time</span><input name="scheduledFor" type="datetime-local" className="input" required /></label><button className="btn-primary">Schedule campaign</button></form>
        </div> : null}
      </section>
    </div>
  );
}
