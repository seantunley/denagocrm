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
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import RecordContextMenu from "@/components/RecordContextMenu";
import { BarChart3, MessageSquareText, Plus, Send, Star } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace-hero";
import { SectionHeading, Surface } from "@/components/visual-system";

export const dynamic = "force-dynamic";

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
      <WorkspaceHero
        icon={MessageSquareText}
        eyebrow="Customer intelligence"
        title="Surveys & feedback"
        description="Measure CSAT, NPS and post-sale experience, then turn customer responses into visible operational signals."
        stats={[
          { label: "Responses", value: totalCompleted, detail: `${responseRate}% response rate`, icon: Send, tone: "primary" },
          { label: "Average CSAT", value: avgCsat === "—" ? "—" : `${avgCsat} / 5`, detail: "Service & sales ratings", icon: Star, tone: avgCsat === "—" ? "default" : "success" },
          { label: "NPS", value: nps === null ? "—" : nps, detail: nps === null ? "No scores yet" : "−100 to +100", icon: BarChart3 },
          { label: "Surveys", value: surveys.length, detail: `${surveys.filter((survey) => survey.active).length} active`, icon: MessageSquareText },
        ]}
      />

      <Surface className="p-5">
        <SectionHeading title={<span className="inline-flex items-center gap-2"><Plus className="size-4 text-primary" /> Create a survey</span>} description="Start with a proven format, then tailor its questions, trigger and delivery." />
        <form action={createSurvey} className="mt-4 flex flex-col gap-2 sm:flex-row">
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
          <button className="btn-primary"><Plus className="size-4" /> Create survey</button>
        </form>
        <p className="text-xs text-slate-500 mt-2">
          We&apos;ll pre-fill sensible questions — you can edit everything next.
        </p>
      </Surface>

      <ResponsiveEntityTable>
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
                <td data-empty colSpan={8} className="text-center text-slate-400 py-8">
                  No surveys yet — create your first one above.
                </td>
              </tr>
            )}
            {surveys.map((s) => {
              const live = s.responses.filter((r) => r.status !== "failed");
              const done = live.filter((r) => r.status === "completed").length;
              const rate = live.length ? Math.round((done / live.length) * 100) : 0;
              return (
                <RecordContextMenu key={s.id} label={s.title} href={`/surveys/${s.id}`}>
                <tr tabIndex={0} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                  <td data-primary data-label="Survey">
                    <Link href={`/surveys/${s.id}`} className="font-medium text-orange-400 hover:underline">
                      {s.title}
                    </Link>
                    {!s.active && (
                      <span className="badge bg-slate-800 text-slate-500 ml-2">inactive</span>
                    )}
                  </td>
                  <td data-label="Type">
                    <span className="badge bg-orange-600/15 text-orange-300">
                      {surveyTypeLabel(s.type)}
                    </span>
                  </td>
                  <td data-label="Sends" className="text-slate-400 text-xs">{triggerLabel(s.trigger)}</td>
                  <td data-label="Sent" className="text-right">{live.length}</td>
                  <td data-label="Responses" className="text-right">{done}</td>
                  <td data-label="Rate" className="text-right">{rate}%</td>
                  <td data-label="Created" className="text-slate-400">{formatDate(s.createdAt)}</td>
                  <td data-actions className="text-right">
                    <form action={deleteSurvey}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="text-xs text-red-400 hover:text-red-300">Delete</button>
                    </form>
                  </td>
                </tr>
                </RecordContextMenu>
              );
            })}
          </tbody>
        </table>
      </ResponsiveEntityTable>
    </div>
  );
}
