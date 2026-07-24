import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { loadSurveyAnalytics } from "@/lib/surveyAnalytics";
import { listTenantStaff } from "@/lib/tenantActor";
import { StatusPill } from "@/components/visual-system";
import { assignSurveyFollowUp, createCaseFromSurveyFollowUp, resolveSurveyFollowUp } from "@/app/actions/surveyFollowUps";

function dateValue(value: string | string[] | undefined, fallback: Date) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? new Date(raw) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export default async function SurveyInsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const params = await searchParams;
  const now = new Date();
  const from = dateValue(params.from, new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000));
  const toInput = dateValue(params.to, now);
  const to = new Date(toInput.getTime() + 24 * 60 * 60 * 1000);
  const surveyId = typeof params.surveyId === "string" ? params.surveyId || null : null;
  const distributionId = typeof params.distributionId === "string" ? params.distributionId || null : null;
  const type = typeof params.type === "string" ? params.type || null : null;
  const channel = typeof params.channel === "string" ? params.channel || null : null;

  const [{ rows, metrics, trend }, surveys, distributions, followUps, staff] = await Promise.all([
    loadSurveyAnalytics({ tenantId, from, to, surveyId, distributionId, type, channel }),
    basePrisma.$queryRaw<Array<{ id: string; title: string }>>`SELECT "id", "title" FROM "Survey" WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId} AND "deletedAt" IS NULL ORDER BY "title"`,
    basePrisma.$queryRaw<Array<{ id: string; name: string }>>`SELECT "id", "name" FROM "SurveyDistribution" WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId} ORDER BY "createdAt" DESC LIMIT 300`,
    basePrisma.$queryRaw<Array<{
      id: string; status: string; severity: string; dueAt: Date | null; ownerId: string | null; caseId: string | null;
      score: number | null; comment: string | null; surveyTitle: string; contactName: string | null;
    }>>`
      SELECT f."id", f."status", f."severity", f."dueAt", f."ownerId", f."caseId", r."score", r."comment",
        s."title" AS "surveyTitle", CONCAT_WS(' ', c."firstName", c."lastName") AS "contactName"
      FROM "SurveyFollowUp" f
      JOIN "SurveyResponse" r ON r."id" = f."surveyResponseId"
      JOIN "Survey" s ON s."id" = r."surveyId"
      LEFT JOIN "Contact" c ON c."id" = f."contactId"
      WHERE f."tenantId" IS NOT DISTINCT FROM ${tenantId} AND f."status" <> 'resolved'
      ORDER BY CASE f."severity" WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, f."dueAt" NULLS LAST
      LIMIT 100
    `,
    listTenantStaff(),
  ]);

  const responseRows = rows.filter((row) => row.status === "completed").slice(0, 100);
  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <Link href="/marketing/surveys" className="text-sm text-primary hover:underline">← Survey governance</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Survey insights</h1>
        <p className="text-sm text-muted-foreground">Response quality, NPS, CSAT, completion speed and unresolved customer recovery.</p>
      </div>
      <Link href="/marketing/surveys/distributions" className="btn-secondary">Distribution queue</Link>
    </div>

    <form className="card grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6">
      <input type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} className="input-base" />
      <input type="date" name="to" defaultValue={toInput.toISOString().slice(0, 10)} className="input-base" />
      <select name="surveyId" defaultValue={surveyId ?? ""} className="input-base"><option value="">All surveys</option>{surveys.map((survey) => <option key={survey.id} value={survey.id}>{survey.title}</option>)}</select>
      <select name="distributionId" defaultValue={distributionId ?? ""} className="input-base"><option value="">All distributions</option>{distributions.map((distribution) => <option key={distribution.id} value={distribution.id}>{distribution.name}</option>)}</select>
      <select name="type" defaultValue={type ?? ""} className="input-base"><option value="">All types</option><option value="nps">NPS</option><option value="csat">CSAT</option><option value="sales">Post-sale</option><option value="adhoc">Ad hoc</option></select>
      <div className="flex gap-2"><select name="channel" defaultValue={channel ?? ""} className="input-base min-w-0 flex-1"><option value="">All channels</option><option value="email">Email</option><option value="sms">SMS</option></select><button className="btn-primary">Apply</button></div>
    </form>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      <div className="card p-4"><p className="text-xs uppercase text-muted-foreground">Delivered invites</p><p className="mt-1 text-2xl font-semibold">{metrics.delivered}</p></div>
      <div className="card p-4"><p className="text-xs uppercase text-muted-foreground">Responses</p><p className="mt-1 text-2xl font-semibold">{metrics.completed}</p></div>
      <div className="card p-4"><p className="text-xs uppercase text-muted-foreground">Response rate</p><p className="mt-1 text-2xl font-semibold">{metrics.responseRate}%</p></div>
      <div className="card p-4"><p className="text-xs uppercase text-muted-foreground">NPS</p><p className="mt-1 text-2xl font-semibold">{metrics.nps ?? "—"}</p><p className="text-xs text-muted-foreground">{metrics.npsResponses} scored</p></div>
      <div className="card p-4"><p className="text-xs uppercase text-muted-foreground">CSAT</p><p className="mt-1 text-2xl font-semibold">{metrics.csat === null ? "—" : `${metrics.csat}%`}</p><p className="text-xs text-muted-foreground">{metrics.csatResponses} scored</p></div>
      <div className="card p-4"><p className="text-xs uppercase text-muted-foreground">Average response</p><p className="mt-1 text-2xl font-semibold">{metrics.averageResponseHours === null ? "—" : `${metrics.averageResponseHours}h`}</p></div>
    </div>

    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <section className="card overflow-x-auto p-0">
        <div className="p-5"><h2 className="font-semibold">Daily response trend</h2><p className="text-sm text-muted-foreground">Delivered and completed use the same eligible denominator.</p></div>
        <table className="table-base"><thead><tr><th>Date</th><th>Delivered</th><th>Completed</th><th>Response rate</th><th>Avg score</th></tr></thead><tbody>{trend.slice(-31).map((day) => <tr key={day.date}><td>{day.date}</td><td>{day.sent}</td><td>{day.completed}</td><td>{day.responseRate}%</td><td>{day.averageScore ?? "—"}</td></tr>)}{trend.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No survey activity in this period.</td></tr>}</tbody></table>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">NPS composition</h2>
        <div className="mt-4 space-y-3">
          <div className="flex justify-between rounded-lg border p-3"><span>Promoters (9–10)</span><strong>{metrics.promoters}</strong></div>
          <div className="flex justify-between rounded-lg border p-3"><span>Passives (7–8)</span><strong>{metrics.passives}</strong></div>
          <div className="flex justify-between rounded-lg border p-3"><span>Detractors (0–6)</span><strong>{metrics.detractors}</strong></div>
        </div>
      </section>
    </div>

    <section className="card space-y-4 p-5">
      <div><h2 className="font-semibold">Closed-loop recovery queue</h2><p className="text-sm text-muted-foreground">Low NPS and CSAT responses automatically create governed follow-ups.</p></div>
      <div className="space-y-3">
        {followUps.map((followUp) => <div key={followUp.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex items-center gap-2"><strong>{followUp.contactName || "Unlinked respondent"}</strong><StatusPill tone={followUp.severity === "critical" ? "danger" : "warning"}>{followUp.severity}</StatusPill><StatusPill tone="neutral">{followUp.status.replaceAll("_", " ")}</StatusPill></div><p className="mt-1 text-sm">{followUp.surveyTitle} · score {followUp.score ?? "—"}</p><p className="mt-1 text-sm text-muted-foreground">{followUp.comment || "No written comment."}</p><p className="mt-1 text-xs text-muted-foreground">Due {followUp.dueAt ? new Date(followUp.dueAt).toLocaleString("en-ZA") : "not set"}</p></div>
            <div className="flex flex-wrap gap-2">
              <form action={assignSurveyFollowUp} className="flex gap-2"><input type="hidden" name="id" value={followUp.id} /><select name="ownerId" defaultValue={followUp.ownerId ?? ""} className="input-base"><option value="">Unassigned</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select><button className="btn-secondary">Assign</button></form>
              {!followUp.caseId && <form action={createCaseFromSurveyFollowUp}><input type="hidden" name="id" value={followUp.id} /><button className="btn-secondary">Create support case</button></form>}
            </div>
          </div>
          <form action={resolveSurveyFollowUp} className="mt-3 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="id" value={followUp.id} /><input name="note" className="input-base flex-1" placeholder="How was this resolved?" required /><button className="btn-primary">Resolve follow-up</button></form>
        </div>)}
        {followUps.length === 0 && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No unresolved negative-feedback follow-ups.</p>}
      </div>
    </section>

    <section className="card overflow-x-auto p-0">
      <div className="p-5"><h2 className="font-semibold">Recent responses</h2></div>
      <table className="table-base"><thead><tr><th>Survey</th><th>Distribution</th><th>Score</th><th>Comment</th><th>Completed</th></tr></thead><tbody>{responseRows.map((row) => <tr key={row.id}><td>{row.surveyTitle}</td><td>{row.distributionName || "Legacy/manual"}</td><td>{row.score ?? "—"}</td><td className="max-w-lg whitespace-normal">{row.comment || "—"}</td><td className="text-xs text-muted-foreground">{row.completedAt ? new Date(row.completedAt).toLocaleString("en-ZA") : "—"}</td></tr>)}{responseRows.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No completed responses.</td></tr>}</tbody></table>
    </section>
  </div>;
}
