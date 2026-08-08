import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, Send, UsersRound } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { MetricCard, MetricStrip, StatusPill } from "@/components/visual-system";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { cancelDistribution, pauseDistribution, resumeDistribution, retryDistributionFailures } from "@/app/actions/surveyDistributions";

export default async function SurveyDistributionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const { id } = await params;
  const rows = await basePrisma.$queryRaw<Array<{
    id: string; name: string; status: string; surveyTitle: string; surveyVersion: number; purpose: string; channel: string;
    totalCount: number; sentCount: number; completedCount: number; failedCount: number; suppressedCount: number;
    scheduledFor: Date | null; reminderAfterHours: number; maxReminders: number; createdAt: Date;
  }>>`
    SELECT d."id", d."name", d."status", s."title" AS "surveyTitle", d."surveyVersion", d."purpose", d."channel",
      d."totalCount", d."sentCount", d."completedCount", d."failedCount", d."suppressedCount",
      d."scheduledFor", d."reminderAfterHours", d."maxReminders", d."createdAt"
    FROM "SurveyDistribution" d JOIN "Survey" s ON s."id" = d."surveyId"
    WHERE d."id" = ${id} AND d."tenantId" IS NOT DISTINCT FROM ${tenantId}
    LIMIT 1
  `;
  const distribution = rows[0];
  if (!distribution) notFound();
  const statusRows = await basePrisma.$queryRaw<Array<{ status: string; count: bigint }>>`
    SELECT "status", COUNT(*)::bigint AS "count"
    FROM "SurveyResponse"
    WHERE "distributionId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    GROUP BY "status" ORDER BY "status"
  `;
  const issues = await basePrisma.$queryRaw<Array<{ id: string; name: string | null; status: string; suppressionReason: string | null; providerStatus: string | null; attemptCount: number }>>`
    SELECT "id", "name", "status", "suppressionReason", "providerStatus", "attemptCount"
    FROM "SurveyResponse"
    WHERE "distributionId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" IN ('failed_temporary', 'failed_permanent', 'suppressed')
    ORDER BY "lastAttemptAt" DESC NULLS LAST
    LIMIT 100
  `;
  const open = new Set(["scheduled", "queued", "sending", "paused"]);

  return <EntityDetailShell
    backHref="/marketing/surveys/distributions"
    backLabel="Survey distributions"
    eyebrow="Survey distribution"
    title={distribution.name}
    status={<StatusPill tone={distribution.status === "completed" ? "success" : distribution.status === "completed_with_errors" ? "warning" : distribution.status === "cancelled" ? "danger" : "neutral"}>{distribution.status.replaceAll("_", " ")}</StatusPill>}
    description={`${distribution.surveyTitle} · version ${distribution.surveyVersion} · ${distribution.purpose.replaceAll("_", " ")} · ${distribution.channel}`}
    actions={<>
      {new Set(["scheduled", "queued", "sending"]).has(distribution.status) && <form action={pauseDistribution}><input type="hidden" name="id" value={id} /><button className="btn-secondary">Pause</button></form>}
      {distribution.status === "paused" && <form action={resumeDistribution}><input type="hidden" name="id" value={id} /><button className="btn-primary">Resume</button></form>}
      {distribution.failedCount > 0 && <form action={retryDistributionFailures}><input type="hidden" name="id" value={id} /><button className="btn-secondary">Retry permanent failures</button></form>}
      {open.has(distribution.status) && <form action={cancelDistribution}><input type="hidden" name="id" value={id} /><button className="btn-secondary">Cancel remaining</button></form>}
    </>}
  >

    <MetricStrip glow="left">
      <MetricCard icon={UsersRound} label="Audience" value={distribution.totalCount} detail="Eligible recipients" />
      <MetricCard icon={Send} label="Sent" value={distribution.sentCount} detail={`${distribution.suppressedCount} policy suppressions`} />
      <MetricCard icon={CheckCircle2} label="Completed" value={distribution.completedCount} detail={distribution.sentCount ? `${Math.round((distribution.completedCount / distribution.sentCount) * 100)}% response rate` : "No sends yet"} accent={distribution.completedCount > 0} />
      <MetricCard icon={AlertTriangle} label="Failed" value={distribution.failedCount} detail="Provider delivery failures" accent={distribution.failedCount > 0} />
    </MetricStrip>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-5"><h2 className="font-semibold">Recipient state</h2><div className="mt-3 space-y-2">{statusRows.map((row) => <div key={row.status} className="flex justify-between rounded-lg border px-3 py-2"><span>{row.status.replaceAll("_", " ")}</span><strong>{Number(row.count)}</strong></div>)}</div></section>
      <section className="card p-5"><h2 className="font-semibold">Delivery settings</h2><dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">Schedule</dt><dd>{distribution.scheduledFor ? new Date(distribution.scheduledFor).toLocaleString("en-ZA") : "Immediate"}</dd></div><div><dt className="text-muted-foreground">Reminder delay</dt><dd>{distribution.reminderAfterHours} hours</dd></div><div><dt className="text-muted-foreground">Maximum reminders</dt><dd>{distribution.maxReminders}</dd></div><div><dt className="text-muted-foreground">Created</dt><dd>{new Date(distribution.createdAt).toLocaleString("en-ZA")}</dd></div></dl></section>
    </div>

    <ResponsiveEntityTable>
      <div className="p-5"><h2 className="font-semibold">Failures and suppressions</h2><p className="text-sm text-muted-foreground">Policy blocks are separated from provider failures.</p></div>
      <table className="table-base"><thead><tr><th>Recipient</th><th>Status</th><th>Reason</th><th>Attempts</th></tr></thead><tbody>{issues.map((issue) => <tr key={issue.id}><td data-primary data-label="Recipient">{issue.name || "Unknown contact"}</td><td data-label="Status">{issue.status.replaceAll("_", " ")}</td><td data-label="Reason">{issue.suppressionReason || issue.providerStatus || "Provider failure"}</td><td data-label="Attempts">{issue.attemptCount}</td></tr>)}{issues.length === 0 && <tr><td data-empty colSpan={4} className="py-10 text-center text-muted-foreground">No delivery issues.</td></tr>}</tbody></table>
    </ResponsiveEntityTable>
  </EntityDetailShell>;
}
