import Link from "next/link";
import { requireCrm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { createSurvey, deleteSurvey } from "@/app/actions/surveys";
import {
  SURVEY_TYPES,
  TRIGGERS,
  npsFromScores,
  surveyTypeLabel,
} from "@/lib/surveyTypes";

export const dynamic = "force-dynamic";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default async function SurveysPage() {
  await requireCrm();

  const surveys = await prisma.survey.findMany({
    orderBy: { createdAt: "desc" },
    include: { responses: { select: { status: true, score: true } } },
  });

  // Overall rollup across every survey
  const ratingScores: number[] = [];
  const npsScores: number[] = [];
  let totalInvites = 0;
  let totalCompleted = 0;
  for (const s of surveys) {
    for (const r of s.responses) {
      if (r.status === "failed") continue;
      totalInvites += 1;
      if (r.status === "completed") {
        totalCompleted += 1;
        if (r.score !== null) {
          if (s.type === "nps") npsScores.push(r.score);
          else ratingScores.push(r.score);
        }
      }
    }
  }
  const avgCsat = ratingScores.length
    ? (ratingScores.reduce((a, b) => a + b, 0) / ratingScores.length).toFixed(1)
    : "—";
  const nps = npsFromScores(npsScores);
  const responseRate = totalInvites ? Math.round((totalCompleted / totalInvites) * 100) : 0;

  const triggerLabel = (t: string | null) =>
    TRIGGERS.find((x) => x.id === (t ?? ""))?.label ?? "Manual only";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Surveys &amp; feedback</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Measure satisfaction — CSAT after a service, NPS loyalty, post-sale and ad-hoc surveys.
          Answers land on the customer&apos;s timeline.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Responses" value={String(totalCompleted)} sub={`${responseRate}% response rate`} />
        <StatCard label="Avg CSAT" value={avgCsat === "—" ? "—" : `${avgCsat} / 5`} sub="service & sales ratings" />
        <StatCard label="NPS" value={nps === null ? "—" : String(nps)} sub={nps === null ? "no scores yet" : "−100 to +100"} />
        <StatCard label="Surveys" value={String(surveys.length)} sub={`${surveys.filter((s) => s.active).length} active`} />
      </div>

      <div className="card">
        <h2 className="font-semibold mb-3">New survey</h2>
        <form action={createSurvey} className="flex flex-col sm:flex-row gap-2">
          <input
            name="title"
            className="input sm:flex-1"
            placeholder="e.g. Post-service satisfaction"
            required
          />
          <select name="type" className="input sm:w-64" defaultValue="csat">
            {SURVEY_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="btn-primary">Create</button>
        </form>
        <p className="text-xs text-slate-500 mt-2">
          We&apos;ll pre-fill sensible questions — you can edit everything next.
        </p>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Survey</th>
              <th>Type</th>
              <th>Sends</th>
              <th className="text-right">Sent</th>
              <th className="text-right">Responses</th>
              <th className="text-right">Rate</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {surveys.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-400 py-8">
                  No surveys yet — create your first one above.
                </td>
              </tr>
            )}
            {surveys.map((s) => {
              const live = s.responses.filter((r) => r.status !== "failed");
              const done = live.filter((r) => r.status === "completed").length;
              const rate = live.length ? Math.round((done / live.length) * 100) : 0;
              return (
                <tr key={s.id}>
                  <td>
                    <Link href={`/surveys/${s.id}`} className="font-medium text-orange-400 hover:underline">
                      {s.title}
                    </Link>
                    {!s.active && (
                      <span className="badge bg-slate-800 text-slate-500 ml-2">inactive</span>
                    )}
                  </td>
                  <td>
                    <span className="badge bg-orange-600/15 text-orange-300">
                      {surveyTypeLabel(s.type)}
                    </span>
                  </td>
                  <td className="text-slate-400 text-xs">{triggerLabel(s.trigger)}</td>
                  <td className="text-right">{live.length}</td>
                  <td className="text-right">{done}</td>
                  <td className="text-right">{rate}%</td>
                  <td className="text-slate-400">{formatDate(s.createdAt)}</td>
                  <td className="text-right">
                    <form action={deleteSurvey}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="text-xs text-red-400 hover:text-red-300">Delete</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
