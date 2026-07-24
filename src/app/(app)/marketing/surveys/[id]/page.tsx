import Link from "next/link";
import { notFound } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { StatusPill } from "@/components/visual-system";
import {
  approveSurvey,
  archiveMarketingSurvey,
  deactivateSurvey,
  publishSurvey,
  requestSurveyChanges,
  reviseSurvey,
  submitSurveyForReview,
} from "@/app/actions/marketingSurveys";

export default async function MarketingSurveyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const { id } = await params;
  const surveys = await basePrisma.$queryRaw<Array<{
    id: string; title: string; type: string; intro: string | null; thankYou: string | null;
    questions: unknown[]; status: string; active: boolean; trigger: string | null;
    delayHours: number; publishedVersion: number | null; reviewNote: string | null;
    submittedForReviewAt: Date | null; approvedAt: Date | null;
  }>>`
    SELECT "id", "title", "type", "intro", "thankYou", "questions", "status", "active",
      "trigger", "delayHours", "publishedVersion", "reviewNote", "submittedForReviewAt", "approvedAt"
    FROM "Survey"
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} AND "deletedAt" IS NULL
    LIMIT 1
  `;
  const survey = surveys[0];
  if (!survey) notFound();
  const versions = await basePrisma.$queryRaw<Array<{ version: number; label: string | null; publishedAt: Date; publishedById: string | null }>>`
    SELECT "version", "label", "publishedAt", "publishedById"
    FROM "SurveyVersion"
    WHERE "surveyId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    ORDER BY "version" DESC
  `;

  const editable = survey.status === "draft" || survey.status === "changes_requested";
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link href="/marketing/surveys" className="text-sm text-primary hover:underline">← Survey governance</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-[-0.03em]">{survey.title}</h1>
          <StatusPill tone={survey.status === "published" ? "success" : survey.status === "changes_requested" ? "warning" : "neutral"}>{survey.status.replaceAll("_", " ")}</StatusPill>
          {survey.publishedVersion && <span className="text-sm text-muted-foreground">Published v{survey.publishedVersion}</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{survey.type.toUpperCase()} · {survey.questions.length} questions · {survey.delayHours} hour delay</p>
      </div>
      {editable && <Link href={`/surveys/${survey.id}`} className="btn-secondary">Edit questions</Link>}
    </div>

    {survey.reviewNote && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"><strong>Changes requested:</strong> {survey.reviewNote}</div>}

    <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <section className="card space-y-4 p-5">
        <div><p className="text-xs uppercase text-muted-foreground">Introduction</p><p className="mt-1 whitespace-pre-wrap">{survey.intro || "No introduction configured."}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Thank-you message</p><p className="mt-1 whitespace-pre-wrap">{survey.thankYou || "No thank-you message configured."}</p></div>
        <div>
          <p className="text-xs uppercase text-muted-foreground">Questions</p>
          <ol className="mt-2 space-y-2">
            {survey.questions.map((value, index) => {
              const question = (value ?? {}) as Record<string, unknown>;
              return <li key={String(question.id ?? index)} className="rounded-lg border p-3"><span className="font-medium">{index + 1}. {String(question.label ?? "Untitled question")}</span><span className="ml-2 text-xs uppercase text-muted-foreground">{String(question.type ?? "unknown")}</span></li>;
            })}
          </ol>
        </div>
      </section>

      <aside className="space-y-4">
        <section className="card space-y-3 p-5">
          <h2 className="font-semibold">Lifecycle controls</h2>
          {editable && <form action={submitSurveyForReview}><input type="hidden" name="id" value={survey.id} /><button className="btn-primary w-full">Submit for review</button></form>}
          {survey.status === "in_review" && <>
            <form action={approveSurvey}><input type="hidden" name="id" value={survey.id} /><button className="btn-primary w-full">Approve</button></form>
            <form action={requestSurveyChanges} className="space-y-2"><input type="hidden" name="id" value={survey.id} /><textarea name="note" className="input-base min-h-24 w-full" placeholder="Required change note" required /><button className="btn-secondary w-full">Request changes</button></form>
          </>}
          {survey.status === "approved" && <form action={publishSurvey} className="space-y-2">
            <input type="hidden" name="id" value={survey.id} />
            <input name="label" className="input-base w-full" placeholder="Version label (optional)" />
            <select name="trigger" className="input-base w-full" defaultValue=""><option value="">Manual distribution</option><option value="job_complete">Job card completed</option><option value="delivery">Delivery completed</option><option value="won">Lead won</option></select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="replaceExisting" value="true" /> Replace another active survey using this trigger</label>
            <button className="btn-primary w-full">Publish immutable version</button>
          </form>}
          {survey.status === "published" && <form action={deactivateSurvey}><input type="hidden" name="id" value={survey.id} /><button className="btn-secondary w-full">Deactivate</button></form>}
          {(survey.status === "published" || survey.status === "inactive") && <form action={reviseSurvey}><input type="hidden" name="id" value={survey.id} /><button className="btn-secondary w-full">Create editable revision</button></form>}
          {survey.status !== "archived" && <form action={archiveMarketingSurvey}><input type="hidden" name="id" value={survey.id} /><button className="btn-danger w-full">Archive</button></form>}
        </section>

        <section className="card p-5">
          <h2 className="font-semibold">Published versions</h2>
          <div className="mt-3 space-y-2">
            {versions.map((version) => <div key={version.version} className="rounded-lg border p-3"><div className="font-medium">Version {version.version}</div><div className="text-xs text-muted-foreground">{version.label || "No label"} · {new Date(version.publishedAt).toLocaleString("en-ZA")}</div></div>)}
            {versions.length === 0 && <p className="text-sm text-muted-foreground">No published version yet.</p>}
          </div>
        </section>
      </aside>
    </div>
  </div>;
}
