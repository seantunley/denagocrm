import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCrm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import SurveyBuilder from "@/components/SurveyBuilder";
import SurveySendPanel from "@/components/SurveySendPanel";
import { npsFromScores, surveyTypeLabel, type SurveyQuestion } from "@/lib/surveyTypes";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

const AUTO_NOTE: Record<string, string> = {
  job_complete: "This survey also sends automatically when a job card is completed.",
  delivery: "This survey also sends automatically when a cart is delivered.",
  won: "This survey also sends automatically when a deal is won.",
};

export default async function SurveyEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCrm();
  const { id } = await params;

  const survey = await prisma.survey.findUnique({
    where: { id },
    include: {
      responses: {
        orderBy: { sentAt: "desc" },
        take: 200,
      },
    },
  });
  if (!survey) notFound();

  const questions = (survey.questions as unknown as SurveyQuestion[]) ?? [];
  const live = survey.responses.filter((r) => r.status !== "failed");
  const completed = live.filter((r) => r.status === "completed");
  const rate = live.length ? Math.round((completed.length / live.length) * 100) : 0;

  const scores = completed.map((r) => r.score).filter((s): s is number => s !== null);
  const summaryStat =
    survey.type === "nps"
      ? { label: "NPS", value: scores.length ? String(npsFromScores(scores)) : "—" }
      : {
          label: "Avg rating",
          value: scores.length
            ? `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)} / 5`
            : "—",
        };

  return (
    <EntityDetailShell
      backHref="/surveys"
      backLabel="Surveys"
      eyebrow="Customer feedback"
      title={survey.title}
      status={<StatusPill tone={survey.active ? "success" : "neutral"}>{survey.active ? "Active" : "Inactive"}</StatusPill>}
      description={`${surveyTypeLabel(survey.type)} survey · ${questions.length} question${questions.length === 1 ? "" : "s"}`}
      facts={[
        { label: "Sent", value: live.length },
        { label: "Responses", value: `${completed.length} · ${rate}%` },
        { label: summaryStat.label, value: summaryStat.value },
        { label: "Trigger", value: survey.trigger ? survey.trigger.replaceAll("_", " ") : "Manual" },
      ]}
    >

      <SurveySendPanel
        surveyId={survey.id}
        autoNote={
          survey.trigger
            ? AUTO_NOTE[survey.trigger] +
              (survey.delayHours > 0
                ? ` It waits ${
                    survey.delayHours % 24 === 0
                      ? `${survey.delayHours / 24} day${survey.delayHours / 24 === 1 ? "" : "s"}`
                      : `${survey.delayHours} hour${survey.delayHours === 1 ? "" : "s"}`
                  } after the event before sending.`
                : "")
            : undefined
        }
      />

      <div>
        <h2 className="font-semibold mb-3">Questions</h2>
        <SurveyBuilder
          survey={{
            id: survey.id,
            title: survey.title,
            intro: survey.intro ?? "",
            thankYou: survey.thankYou ?? "",
            active: survey.active,
            trigger: survey.trigger ?? "",
            delayHours: survey.delayHours,
            questions,
          }}
        />
      </div>

      <div>
        <h2 className="font-semibold mb-3">Responses</h2>
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Recipient</th>
                <th className="text-right">Score</th>
                <th>Comment</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {live.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-8">
                    No one has been surveyed yet.
                  </td>
                </tr>
              )}
              {live.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.contactId ? (
                      <Link
                        href={`/contacts/${r.contactId}`}
                        className="text-orange-400 hover:underline"
                      >
                        {r.name || "Customer"}
                      </Link>
                    ) : (
                      r.name || "—"
                    )}
                  </td>
                  <td className="text-right font-semibold">{r.score ?? "—"}</td>
                  <td className="text-slate-300 max-w-xs truncate" title={r.comment ?? ""}>
                    {r.comment || "—"}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        r.status === "completed"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="text-slate-400">
                    {formatDateTime(r.completedAt ?? r.sentAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </EntityDetailShell>
  );
}
