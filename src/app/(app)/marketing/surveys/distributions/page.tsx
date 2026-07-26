import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { StatusPill } from "@/components/visual-system";
import { PageHeader } from "@/components/page-header";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { createDistribution } from "@/app/actions/surveyDistributions";

export default async function SurveyDistributionsPage() {
  await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const surveys = await basePrisma.$queryRaw<Array<{ id: string; title: string; publishedVersion: number }>>`
    SELECT "id", "title", "publishedVersion"
    FROM "Survey"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" = 'published' AND "active" = true AND "deletedAt" IS NULL
    ORDER BY "title"
  `;
  const distributions = await basePrisma.$queryRaw<Array<{
    id: string; name: string; surveyTitle: string; surveyVersion: number; status: string;
    totalCount: number; sentCount: number; completedCount: number; failedCount: number;
    suppressedCount: number; scheduledFor: Date | null; createdAt: Date;
  }>>`
    SELECT d."id", d."name", s."title" AS "surveyTitle", d."surveyVersion", d."status",
      d."totalCount", d."sentCount", d."completedCount", d."failedCount", d."suppressedCount",
      d."scheduledFor", d."createdAt"
    FROM "SurveyDistribution" d
    JOIN "Survey" s ON s."id" = d."surveyId"
    WHERE d."tenantId" IS NOT DISTINCT FROM ${tenantId}
    ORDER BY d."createdAt" DESC
    LIMIT 200
  `;

  return <div className="space-y-6">
    <div>
      <Link href="/marketing/surveys" className="text-sm text-primary hover:underline">← Survey governance</Link>
      <PageHeader className="mt-2" title="Survey distributions" description="Create bounded, consent-aware survey sends with reminders and operational controls." />
    </div>

    <form action={createDistribution} className="card grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-4">
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Distribution name</label><input name="name" className="input-base mt-1 w-full" placeholder="July service follow-up" required /></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Published survey</label><select name="surveyId" className="input-base mt-1 w-full" required>{surveys.map((survey) => <option key={survey.id} value={survey.id}>{survey.title} · v{survey.publishedVersion}</option>)}</select></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Audience</label><select name="segment" className="input-base mt-1 w-full"><option value="customers">All reachable contacts</option><option value="vehicle_owners">Vehicle owners</option><option value="won_leads">Won customers</option></select></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Purpose</label><select name="purpose" className="input-base mt-1 w-full"><option value="survey_transactional">Transactional feedback</option><option value="survey_marketing">Marketing research</option></select></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Channel</label><select name="channel" className="input-base mt-1 w-full"><option value="any">Best available</option><option value="email">Email only</option><option value="sms">SMS only</option></select></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Schedule</label><input type="datetime-local" name="scheduledFor" className="input-base mt-1 w-full" /></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Reminder after hours</label><input type="number" name="reminderAfterHours" min="1" max="720" defaultValue="48" className="input-base mt-1 w-full" /></div>
      <div><label className="text-xs font-medium uppercase text-muted-foreground">Maximum reminders</label><input type="number" name="maxReminders" min="0" max="3" defaultValue="1" className="input-base mt-1 w-full" /></div>
      <div className="md:col-span-2 xl:col-span-4"><button className="btn-primary" disabled={surveys.length === 0}>Create queued distribution</button>{surveys.length === 0 && <span className="ml-3 text-sm text-muted-foreground">Publish a survey first.</span>}</div>
    </form>

    <ResponsiveEntityTable>
      <table className="table-base">
        <thead><tr><th>Distribution</th><th>Survey</th><th>Status</th><th>Sent</th><th>Completed</th><th>Issues</th><th>Schedule</th></tr></thead>
        <tbody>
          {distributions.map((item) => <tr key={item.id}>
            <td data-primary data-label="Distribution"><Link href={`/marketing/surveys/distributions/${item.id}`} className="font-medium text-primary hover:underline">{item.name}</Link></td>
            <td data-label="Survey">{item.surveyTitle} <span className="text-xs text-muted-foreground">v{item.surveyVersion}</span></td>
            <td data-label="Status"><StatusPill tone={item.status === "completed" ? "success" : item.status === "completed_with_errors" ? "warning" : item.status === "cancelled" ? "danger" : "neutral"}>{item.status.replaceAll("_", " ")}</StatusPill></td>
            <td data-label="Sent">{item.sentCount}/{item.totalCount}</td>
            <td data-label="Completed">{item.completedCount}</td>
            <td data-label="Issues">{item.failedCount + item.suppressedCount}</td>
            <td data-label="Schedule" className="text-xs text-muted-foreground">{item.scheduledFor ? new Date(item.scheduledFor).toLocaleString("en-ZA") : "Immediate"}</td>
          </tr>)}
          {distributions.length === 0 && <tr><td data-empty colSpan={7} className="py-12 text-center text-muted-foreground">No survey distributions yet.</td></tr>}
        </tbody>
      </table>
    </ResponsiveEntityTable>
  </div>;
}
