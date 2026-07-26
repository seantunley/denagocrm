import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { StatusPill } from "@/components/visual-system";
import { PageHeader } from "@/components/page-header";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { createMarketingSurvey } from "@/app/actions/marketingSurveys";

export default async function MarketingSurveysPage() {
  await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const surveys = await basePrisma.$queryRaw<Array<{
    id: string; title: string; type: string; status: string; active: boolean;
    trigger: string | null; publishedVersion: number | null; updatedAt: Date;
  }>>`
    SELECT "id", "title", "type", "status", "active", "trigger", "publishedVersion", "updatedAt"
    FROM "Survey"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId} AND "deletedAt" IS NULL
    ORDER BY "updatedAt" DESC
    LIMIT 200
  `;
  const counts = surveys.reduce<Record<string, number>>((acc, survey) => {
    acc[survey.status] = (acc[survey.status] ?? 0) + 1;
    return acc;
  }, {});

  return <div className="space-y-6">
    <PageHeader title="Survey governance" description="Draft, review, approve and publish immutable customer-feedback forms.">
      <form action={createMarketingSurvey} className="flex flex-wrap gap-2">
        <input name="title" className="input-base min-w-52" placeholder="New survey name" required />
        <select name="type" className="input-base"><option value="csat">CSAT</option><option value="sales">Post-sale</option><option value="nps">NPS</option><option value="adhoc">Ad hoc</option></select>
        <button className="btn-primary">Create inactive draft</button>
      </form>
    </PageHeader>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {[["draft","Drafts"],["in_review","In review"],["approved","Approved"],["published","Published"],["inactive","Inactive"]].map(([key,label]) =>
        <div className="card p-4" key={key}><p className="text-xs uppercase text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{counts[key] ?? 0}</p></div>
      )}
    </div>

    <ResponsiveEntityTable>
      <table className="table-base">
        <thead><tr><th>Survey</th><th>Type</th><th>Status</th><th>Version</th><th>Trigger</th><th>Updated</th></tr></thead>
        <tbody>
          {surveys.map((survey) => <tr key={survey.id}>
            <td data-primary data-label="Survey"><Link href={`/marketing/surveys/${survey.id}`} className="font-medium text-primary hover:underline">{survey.title}</Link></td>
            <td data-label="Type" className="uppercase text-muted-foreground">{survey.type}</td>
            <td data-label="Status"><StatusPill tone={survey.status === "published" ? "success" : survey.status === "changes_requested" ? "warning" : "neutral"}>{survey.status.replaceAll("_", " ")}</StatusPill></td>
            <td data-label="Version">{survey.publishedVersion ? `v${survey.publishedVersion}` : "—"}</td>
            <td data-label="Trigger">{survey.trigger ?? "Manual"}</td>
            <td data-label="Updated" className="text-xs text-muted-foreground">{new Date(survey.updatedAt).toLocaleString("en-ZA")}</td>
          </tr>)}
          {surveys.length === 0 && <tr><td data-empty colSpan={6} className="py-12 text-center text-muted-foreground">No surveys yet.</td></tr>}
        </tbody>
      </table>
    </ResponsiveEntityTable>
  </div>;
}
